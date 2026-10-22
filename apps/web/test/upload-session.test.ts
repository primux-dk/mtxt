import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE_BYTES } from '@mtxt/contract';
import type { StorageAdapter, StoredObject } from '@mtxt/adapters';
import {
  checkChunks,
  expectedChunkSize,
  SESSION_TTL_MS,
  UploadSessionCore,
  type SessionState,
  type SessionStore,
} from '../lib/uploads/session';

/** Multipart semantics as R2 and S3 have them, in memory. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let next = 0;
  const describe = (key: string, bytes: Uint8Array): StoredObject => ({ key, size: bytes.length });
  const storage = {
    objects,
    uploads,
    async createUpload(key: string) {
      const uploadId = `u${++next}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    async uploadPart(_key: string, uploadId: string, partNumber: number, body: ArrayBuffer) {
      uploads.get(uploadId)!.parts.set(partNumber, new Uint8Array(body.slice(0)));
      return { partNumber, etag: `e${partNumber}` };
    },
    async completeUpload(key: string, uploadId: string, parts: { partNumber: number }[]) {
      const upload = uploads.get(uploadId)!;
      const pieces = parts.map((p) => upload.parts.get(p.partNumber)!);
      const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const piece of pieces) {
        bytes.set(piece, at);
        at += piece.length;
      }
      objects.set(key, bytes);
      uploads.delete(uploadId);
      return describe(key, bytes);
    },
    async abortUpload(_key: string, uploadId: string) {
      uploads.delete(uploadId);
    },
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 1 << 20) {
            controller.enqueue(bytes.subarray(at, at + (1 << 20)));
          }
          controller.close();
        },
      });
      return { ...describe(key, bytes), body };
    }),
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? describe(key, bytes) : null;
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async put() {
      throw new Error('not used');
    },
    async read() {
      throw new Error('not used');
    },
  };
  return storage as typeof storage & StorageAdapter;
}

function memoryStore(): SessionStore & { state?: SessionState } {
  const store: SessionStore & { state?: SessionState } = {
    async load() {
      return store.state ? structuredClone(store.state) : undefined;
    },
    async save(state) {
      store.state = structuredClone(state);
    },
    async clear() {
      store.state = undefined;
    },
  };
  return store;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const chunk = (file: Uint8Array, n: number) =>
  file.slice((n - 1) * CHUNK_SIZE_BYTES, n * CHUNK_SIZE_BYTES).buffer;

// Two full chunks and a short last one.
const file = new Uint8Array(randomBytes(2 * CHUNK_SIZE_BYTES + 12_345));
const KEY = 'recordings/dev/m1/r1.webm';
const init = (overrides: Partial<SessionState> = {}) => ({
  recordingId: 'r1',
  installId: 'dev',
  meetingId: 'm1',
  key: KEY,
  contentType: 'audio/webm',
  sizeBytes: file.length,
  sha256: sha(file),
  ...overrides,
});

describe('chunk bookkeeping', () => {
  it('knows the size of every chunk', () => {
    const size = 2 * CHUNK_SIZE_BYTES + 5;
    expect(expectedChunkSize(size, 1)).toBe(CHUNK_SIZE_BYTES);
    expect(expectedChunkSize(size, 3)).toBe(5);
    expect(expectedChunkSize(size, 4)).toBe(0);
    expect(expectedChunkSize(CHUNK_SIZE_BYTES, 1)).toBe(CHUNK_SIZE_BYTES);
    expect(expectedChunkSize(1, 1)).toBe(1);
  });

  it('finds missing, misfitting and extra chunks', () => {
    const size = 2 * CHUNK_SIZE_BYTES + 5;
    const part = (s: number) => ({ etag: 'e', size: s });
    expect(checkChunks({ 1: part(CHUNK_SIZE_BYTES), 3: part(5) }, size)).toEqual({
      ok: false,
      missing: [2],
    });
    expect(
      checkChunks({ 1: part(CHUNK_SIZE_BYTES), 2: part(CHUNK_SIZE_BYTES), 3: part(6) }, size),
    ).toEqual({ ok: false, wrongSize: [3] });
    expect(checkChunks({ 1: part(5), 2: part(5) }, 5)).toEqual({ ok: false, wrongSize: [2] });
    expect(
      checkChunks({ 1: part(CHUNK_SIZE_BYTES), 2: part(CHUNK_SIZE_BYTES), 3: part(5) }, size),
    ).toEqual({ ok: true });
  });
});

describe('UploadSessionCore', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let store: ReturnType<typeof memoryStore>;
  let session: UploadSessionCore;
  beforeEach(async () => {
    storage = memoryStorage();
    store = memoryStore();
    session = new UploadSessionCore(storage, store);
  });

  it('confirms chunks sent in order with the running hash, without reading the file back', async () => {
    await session.begin(init());
    for (const n of [1, 2, 3]) {
      const receipt = await session.putChunk(n, chunk(file, n));
      expect(receipt).toMatchObject({ ok: true, n, chunkCount: 3 });
    }
    expect(await session.complete()).toEqual({
      ok: true,
      sha256: sha(file),
      sizeBytes: file.length,
    });
    expect(storage.get).not.toHaveBeenCalled();
    expect(sha(storage.objects.get(KEY)!)).toBe(sha(file));
  });

  it('confirms chunks out of order by streaming the stored file once', async () => {
    await session.begin(init());
    for (const n of [3, 1, 2]) await session.putChunk(n, chunk(file, n));
    expect((await session.status()).chunksReceived).toEqual([1, 2, 3]);
    expect(await session.complete()).toMatchObject({ ok: true });
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('lists missing chunks and confirms once they arrive', async () => {
    await session.begin(init());
    await session.putChunk(1, chunk(file, 1));
    await session.putChunk(3, chunk(file, 3));
    expect(await session.complete()).toMatchObject({
      ok: false,
      code: 'missing_chunks',
      missing: [2],
    });
    await session.putChunk(2, chunk(file, 2));
    expect(await session.complete()).toMatchObject({ ok: true });
  });

  it('fails on a wrong hash, deletes the file, and keeps saying so', async () => {
    await session.begin(init({ sha256: 'f'.repeat(64) }));
    for (const n of [1, 2, 3]) await session.putChunk(n, chunk(file, n));
    expect(await session.complete()).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(storage.objects.has(KEY)).toBe(false);
    expect(await session.status()).toMatchObject({ status: 'failed', failure: 'hash_mismatch' });
    expect(await session.complete()).toMatchObject({ ok: false, code: 'hash_mismatch' });
    expect(await session.putChunk(1, chunk(file, 1))).toMatchObject({ code: 'not_uploading' });
  });

  it('answers a second complete the same way', async () => {
    await session.begin(init());
    for (const n of [1, 2, 3]) await session.putChunk(n, chunk(file, n));
    const first = await session.complete();
    expect(await session.complete()).toEqual(first);
  });

  it('shares one verification between two completes at once', async () => {
    await session.begin(init());
    for (const n of [2, 1, 3]) await session.putChunk(n, chunk(file, n));
    const [a, b] = await Promise.all([session.complete(), session.complete()]);
    expect(a).toEqual(b);
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('refuses a chunk of the wrong size or past the end', async () => {
    await session.begin(init());
    expect(await session.putChunk(1, new ArrayBuffer(10))).toMatchObject({ code: 'chunk_size' });
    expect(await session.putChunk(4, new ArrayBuffer(10))).toMatchObject({ code: 'chunk_size' });
    expect(await session.putChunk(1, new ArrayBuffer(0))).toMatchObject({ code: 'chunk_size' });
    expect(await session.putChunk(1, new ArrayBuffer(CHUNK_SIZE_BYTES + 1))).toMatchObject({
      code: 'too_large',
    });
  });

  it('takes a chunk sent twice and still verifies the right bytes', async () => {
    await session.begin(init());
    await session.putChunk(1, chunk(file, 1));
    await session.putChunk(1, new Uint8Array(CHUNK_SIZE_BYTES).buffer);
    await session.putChunk(1, chunk(file, 1));
    for (const n of [2, 3]) await session.putChunk(n, chunk(file, n));
    expect(await session.complete()).toMatchObject({ ok: true });
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('survives a restart: memory is gone, the parts and the state are not', async () => {
    await session.begin(init());
    await session.putChunk(1, chunk(file, 1));
    const restarted = new UploadSessionCore(storage, store);
    await restarted.putChunk(2, chunk(file, 2));
    await restarted.putChunk(3, chunk(file, 3));
    expect(await restarted.complete()).toMatchObject({ ok: true });
    expect(storage.get).toHaveBeenCalledOnce();
  });

  it('takes the size and hash at complete when the recording was still being made', async () => {
    await session.begin(init({ sha256: null, sizeBytes: null }));
    for (const n of [1, 2, 3]) {
      expect(await session.putChunk(n, chunk(file, n))).toMatchObject({
        ok: true,
        chunkCount: null,
      });
    }
    expect(await session.complete()).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await session.complete({ sha256: sha(file), sizeBytes: file.length + 1 })).toMatchObject(
      {
        ok: false,
        code: 'size_mismatch',
      },
    );
  });

  it('confirms a streamed recording with its final size and hash', async () => {
    await session.begin(init({ sha256: null, sizeBytes: null }));
    for (const n of [1, 2, 3]) await session.putChunk(n, chunk(file, n));
    expect(await session.complete({ sha256: sha(file), sizeBytes: file.length })).toEqual({
      ok: true,
      sha256: sha(file),
      sizeBytes: file.length,
    });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('refuses a final hash that differs from the announced one', async () => {
    await session.begin(init());
    for (const n of [1, 2, 3]) await session.putChunk(n, chunk(file, n));
    expect(
      await session.complete({ sha256: 'a'.repeat(64), sizeBytes: file.length }),
    ).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('aborts an upload left open for 7 days, then forgets it', async () => {
    let now = 1_000;
    session = new UploadSessionCore(storage, store, () => now);
    await session.begin(init());
    await session.putChunk(1, chunk(file, 1));
    expect(await session.expire()).toBe(false);
    now += SESSION_TTL_MS;
    expect(await session.expire()).toBe(true);
    expect(storage.uploads.size).toBe(0);
    expect(await session.complete()).toMatchObject({ code: 'session_expired' });
    expect(await session.expire()).toBe(false);
    expect(store.state).toBeUndefined();
  });

  it('begins once', async () => {
    await session.begin(init());
    await session.begin(init());
    expect(storage.uploads.size).toBe(1);
  });
});
