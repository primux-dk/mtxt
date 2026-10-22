import { createHash, type Hash } from 'node:crypto';
import { CHUNK_SIZE_BYTES, MAX_RECORDING_BYTES } from '@mtxt/contract';
import type {
  ChunkResult,
  CompleteResult,
  SessionStatus,
  StorageAdapter,
  UploadSession,
  UploadSessionInit,
} from '@mtxt/adapters';

export const MAX_CHUNKS = MAX_RECORDING_BYTES / CHUNK_SIZE_BYTES;
/** An upload that is not complete after 7 days is aborted. */
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

export interface SessionState extends UploadSessionInit {
  v: 1;
  uploadId: string;
  createdAt: number;
  /** Chunk number to its stored part. JSON keys, so strings. */
  parts: Record<string, { etag: string; size: number }>;
  status: 'uploading' | 'confirmed' | 'failed';
  failure: string | null;
}

/** Where a session keeps its state: Durable Object storage, or a database row. */
export interface SessionStore {
  load(): Promise<SessionState | undefined>;
  save(state: SessionState): Promise<void>;
  clear(): Promise<void>;
}

const numbers = (state: SessionState) =>
  Object.keys(state.parts)
    .map(Number)
    .sort((a, b) => a - b);

export const chunkCountFor = (sizeBytes: number) => Math.ceil(sizeBytes / CHUNK_SIZE_BYTES);

/** The size chunk `n` must have in a file of `sizeBytes`. 0 when n is past the end. */
export function expectedChunkSize(sizeBytes: number, n: number): number {
  const count = chunkCountFor(sizeBytes);
  if (n < 1 || n > count) return 0;
  return n < count ? CHUNK_SIZE_BYTES : sizeBytes - (count - 1) * CHUNK_SIZE_BYTES;
}

/**
 * Checks the received chunks against the final size: every chunk present,
 * every chunk the right size, nothing past the end.
 */
export function checkChunks(
  parts: SessionState['parts'],
  sizeBytes: number,
): { ok: true } | { ok: false; missing: number[] } | { ok: false; wrongSize: number[] } {
  const count = chunkCountFor(sizeBytes);
  const wrongSize = Object.entries(parts)
    .filter(([n, part]) => part.size !== expectedChunkSize(sizeBytes, Number(n)))
    .map(([n]) => Number(n));
  if (wrongSize.length) return { ok: false, wrongSize: wrongSize.sort((a, b) => a - b) };
  const missing: number[] = [];
  for (let n = 1; n <= count; n++) if (!parts[n]) missing.push(n);
  return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * One resumable upload: the bookkeeping behind the four contract calls,
 * independent of where it runs. The Durable Object in
 * apps/web/workers/upload-session.ts wraps it.
 *
 * Each chunk becomes its own part of a multipart upload. While chunks arrive
 * in order the SHA-256 is computed as they come; a chunk out of order, a
 * chunk sent twice, or a restart of the object (memory is lost, storage is
 * not) drops the running hash, and complete hashes the finished object by
 * streaming it once. Only one chunk is ever held in memory.
 */
export class UploadSessionCore implements UploadSession {
  private state: SessionState | undefined;
  private loaded = false;
  private hash: Hash | null = null;
  /** The last chunk number the running hash covers; -1 once it cannot be used. */
  private hashedThrough = 0;
  private completing: Promise<CompleteResult> | null = null;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async current(): Promise<SessionState | undefined> {
    if (!this.loaded) {
      this.state = await this.store.load();
      this.loaded = true;
    }
    return this.state;
  }

  private async save(state: SessionState) {
    this.state = state;
    await this.store.save(state);
  }

  /** When the session should next be looked at: expiry while uploading. */
  expiresAt(): number | null {
    return this.state ? this.state.createdAt + SESSION_TTL_MS : null;
  }

  async begin(init: UploadSessionInit): Promise<void> {
    if (await this.current()) return;
    const { uploadId } = await this.storage.createUpload(init.key, {
      contentType: init.contentType,
      customMetadata: { recordingId: init.recordingId, meetingId: init.meetingId },
    });
    await this.save({
      ...init,
      v: 1,
      uploadId,
      createdAt: this.now(),
      parts: {},
      status: 'uploading',
      failure: null,
    });
  }

  async putChunk(n: number, bytes: ArrayBuffer): Promise<ChunkResult> {
    const state = await this.current();
    if (!state || state.status !== 'uploading') {
      return {
        ok: false,
        code: 'not_uploading',
        message: 'The recording is not accepting chunks.',
      };
    }
    if (n > MAX_CHUNKS || bytes.byteLength > CHUNK_SIZE_BYTES) {
      return {
        ok: false,
        code: 'too_large',
        message: 'Past the largest file the install accepts.',
      };
    }
    const size = bytes.byteLength;
    if (size === 0) return { ok: false, code: 'chunk_size', message: 'The chunk is empty.' };
    if (state.sizeBytes !== null && size !== expectedChunkSize(state.sizeBytes, n)) {
      const expected = expectedChunkSize(state.sizeBytes, n);
      return {
        ok: false,
        code: 'chunk_size',
        message: expected
          ? `Chunk ${n} must be ${expected} bytes, not ${size}.`
          : `Chunk ${n} is past the end of the file.`,
      };
    }

    // Hash now, before the first await, so chunks are hashed in arrival order.
    if (state.parts[n] || n <= this.hashedThrough) {
      this.dropHash();
    } else if (n === this.hashedThrough + 1) {
      this.hash ??= createHash('sha256');
      this.hash.update(new Uint8Array(bytes));
      this.hashedThrough = n;
    }

    const part = await this.storage.uploadPart(state.key, state.uploadId, n, bytes);
    state.parts[n] = { etag: part.etag, size };
    await this.save(state);
    return {
      ok: true,
      n,
      sizeBytes: size,
      chunksReceived: numbers(state),
      chunkCount: state.sizeBytes === null ? null : chunkCountFor(state.sizeBytes),
    };
  }

  private dropHash() {
    this.hash = null;
    this.hashedThrough = -1;
  }

  complete(final?: { sha256: string; sizeBytes: number }): Promise<CompleteResult> {
    // Two completes at once share one verification.
    this.completing ??= this.verify(final).finally(() => {
      this.completing = null;
    });
    return this.completing;
  }

  private async verify(final?: { sha256: string; sizeBytes: number }): Promise<CompleteResult> {
    const state = await this.current();
    if (!state) return { ok: false, code: 'not_uploading', message: 'No upload session.' };
    if (state.status === 'confirmed') {
      return { ok: true, sha256: state.sha256!, sizeBytes: state.sizeBytes! };
    }
    if (state.status === 'failed') {
      return {
        ok: false,
        code: (state.failure as 'hash_mismatch') ?? 'hash_mismatch',
        message: 'The upload failed. Start again.',
      };
    }

    const sha256 = state.sha256 ?? final?.sha256 ?? null;
    const sizeBytes = state.sizeBytes ?? final?.sizeBytes ?? null;
    if (sha256 === null || sizeBytes === null) {
      return { ok: false, code: 'invalid_request', message: 'Send sha256 and size_bytes.' };
    }
    if (final && (final.sha256 !== sha256 || final.sizeBytes !== sizeBytes)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'sha256 and size_bytes differ from the create request.',
      };
    }

    const check = checkChunks(state.parts, sizeBytes);
    if (!check.ok && 'missing' in check) {
      return {
        ok: false,
        code: 'missing_chunks',
        message: `Missing chunks: ${check.missing.join(', ')}.`,
        missing: check.missing,
      };
    }
    if (!check.ok) {
      await this.storage.abortUpload(state.key, state.uploadId).catch(() => {});
      return this.fail(state, 'size_mismatch', `Chunks ${check.wrongSize.join(', ')} do not fit.`);
    }

    const parts = numbers(state).map((n) => ({ partNumber: n, etag: state.parts[n]!.etag }));
    const object = await this.storage.completeUpload(state.key, state.uploadId, parts);
    if (object.size !== sizeBytes) {
      await this.storage.delete(state.key);
      return this.fail(
        state,
        'size_mismatch',
        `Stored ${object.size} bytes, expected ${sizeBytes}.`,
      );
    }

    const count = chunkCountFor(sizeBytes);
    const actual =
      this.hash && this.hashedThrough === count
        ? this.hash.digest('hex')
        : await this.hashStored(state.key);
    this.dropHash();
    if (actual !== sha256) {
      await this.storage.delete(state.key);
      return this.fail(state, 'hash_mismatch', 'The SHA-256 of the file does not match.');
    }

    await this.save({ ...state, sha256, sizeBytes, status: 'confirmed' });
    return { ok: true, sha256, sizeBytes };
  }

  private async hashStored(key: string): Promise<string> {
    const object = await this.storage.get(key);
    if (!object) throw new Error(`The completed upload ${key} is not in storage`);
    const hash = createHash('sha256');
    const reader = object.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return hash.digest('hex');
      hash.update(value);
    }
  }

  private async fail(
    state: SessionState,
    code: 'hash_mismatch' | 'size_mismatch' | 'session_expired',
    message: string,
  ): Promise<CompleteResult> {
    await this.save({ ...state, status: 'failed', failure: code });
    return { ok: false, code, message };
  }

  async status(): Promise<SessionStatus> {
    const state = await this.current();
    if (!state) return { status: 'none', chunksReceived: [], chunkCount: null, failure: null };
    return {
      status: state.status,
      chunksReceived: state.status === 'uploading' ? numbers(state) : [],
      chunkCount: state.sizeBytes === null ? null : chunkCountFor(state.sizeBytes),
      failure: state.failure,
    };
  }

  async abort(): Promise<void> {
    const state = await this.current();
    if (state?.status === 'uploading') {
      await this.storage.abortUpload(state.key, state.uploadId).catch(() => {});
    }
    this.dropHash();
    this.state = undefined;
    await this.store.clear();
  }

  /**
   * Called when the session's time is up. An upload still open after 7 days
   * is aborted and marked `session_expired` (returns true, so the caller can
   * update the recording); a finished session is forgotten.
   */
  async expire(): Promise<boolean> {
    const state = await this.current();
    if (!state) return false;
    if (state.status === 'uploading' && this.now() >= state.createdAt + SESSION_TTL_MS) {
      await this.storage.abortUpload(state.key, state.uploadId).catch(() => {});
      await this.fail(state, 'session_expired', 'The upload was not completed within 7 days.');
      return true;
    }
    if (state.status !== 'uploading') {
      this.state = undefined;
      await this.store.clear();
    }
    return false;
  }
}
