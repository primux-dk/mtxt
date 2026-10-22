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
  /**
   * `finalizing` is written before R2 assembles the file, with the final
   * size and hash, so a restart in the middle can finish the job instead of
   * asking R2 to complete an upload it already completed.
   */
  status: 'uploading' | 'finalizing' | 'confirmed' | 'failed';
  failure: string | null;
  /** The running hash, when every chunk arrived in order; else null and complete streams the file. */
  computedSha256?: string | null;
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

/** Why a body read stopped. */
type ReadOutcome = { bytes: Uint8Array } | { tooLarge: true };

/**
 * One resumable upload: the bookkeeping behind the four contract calls,
 * independent of where it runs. The Durable Object in
 * apps/web/workers/upload-session.ts wraps it.
 *
 * Every mutation runs one at a time on an in-object queue, so a late chunk
 * can never write its state over a confirmation. One chunk body is admitted
 * at a time; a second PUT meanwhile answers `busy` without reading its body,
 * so the session never holds more than one chunk in memory.
 *
 * Each chunk becomes its own part of a multipart upload. While chunks arrive
 * in order the SHA-256 is computed as they come; a chunk out of order, a
 * chunk sent twice, or a restart of the object (memory is lost, storage is
 * not) drops the running hash, and complete hashes the finished object by
 * streaming it once.
 */
export class UploadSessionCore implements UploadSession {
  private state: SessionState | undefined;
  private loaded = false;
  private hash: Hash | null = null;
  /** The last chunk number the running hash covers; -1 once it cannot be used. */
  private hashedThrough = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private receiving = false;
  private completing: Promise<CompleteResult> | null = null;
  private bufferedBytes = 0;
  private peakBufferedBytes = 0;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs `task` after every earlier mutation has finished. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

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

  begin(init: UploadSessionInit): Promise<void> {
    return this.exclusive(async () => {
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
    });
  }

  async putChunk(
    n: number,
    body: ReadableStream<Uint8Array> | ArrayBuffer | null,
  ): Promise<ChunkResult> {
    const refuse = async (result: ChunkResult) => {
      if (body instanceof ReadableStream) await body.cancel().catch(() => {});
      return result;
    };
    // Checked before anything awaits, so two PUTs cannot both get in.
    if (this.receiving || this.completing) {
      return refuse({ ok: false, code: 'busy', message: 'Another chunk is being written. Retry.' });
    }
    this.receiving = true;
    try {
      return await this.exclusive(async () => {
        const state = await this.current();
        if (!state || state.status !== 'uploading') {
          return refuse({
            ok: false,
            code: 'not_uploading',
            message: 'The recording is not accepting chunks.',
          });
        }
        if (n > MAX_CHUNKS) {
          return refuse({
            ok: false,
            code: 'too_large',
            message: 'Past the largest file the install accepts.',
          });
        }
        const expected = state.sizeBytes === null ? null : expectedChunkSize(state.sizeBytes, n);
        if (expected === 0) {
          return refuse({
            ok: false,
            code: 'chunk_size',
            message: `Chunk ${n} is past the end of the file.`,
          });
        }

        const read = await this.read(body, expected ?? CHUNK_SIZE_BYTES);
        try {
          if ('tooLarge' in read) {
            return {
              ok: false,
              code: 'too_large',
              message: `A chunk is at most ${CHUNK_SIZE_BYTES} bytes.`,
            };
          }
          const bytes = read.bytes;
          const size = bytes.byteLength;
          if (size === 0) return { ok: false, code: 'chunk_size', message: 'The chunk is empty.' };
          if (expected !== null && size !== expected) {
            return {
              ok: false,
              code: 'chunk_size',
              message: `Chunk ${n} must be ${expected} bytes, not ${size}.`,
            };
          }

          if (state.parts[n] || n <= this.hashedThrough) {
            this.dropHash();
          } else if (n === this.hashedThrough + 1) {
            this.hash ??= createHash('sha256');
            this.hash.update(bytes);
            this.hashedThrough = n;
          }

          const part = await this.storage.uploadPart(state.key, state.uploadId, n, bytes);
          await this.save({ ...state, parts: { ...state.parts, [n]: { etag: part.etag, size } } });
          return {
            ok: true,
            n,
            sizeBytes: size,
            chunksReceived: numbers(this.state!),
            chunkCount: state.sizeBytes === null ? null : chunkCountFor(state.sizeBytes),
          };
        } finally {
          this.release(read);
        }
      });
    } finally {
      this.receiving = false;
    }
  }

  /**
   * Reads a chunk body into one buffer of at most `limit` bytes, counting
   * what is held. One byte more and the read stops: the rest is never read.
   */
  private async read(
    body: ReadableStream<Uint8Array> | ArrayBuffer | null,
    limit: number,
  ): Promise<ReadOutcome> {
    if (body === null) return { bytes: new Uint8Array(0) };
    if (body instanceof ArrayBuffer) {
      if (body.byteLength > limit && body.byteLength > CHUNK_SIZE_BYTES) return { tooLarge: true };
      this.hold(body.byteLength);
      return { bytes: new Uint8Array(body) };
    }
    const buffer = new Uint8Array(limit);
    let filled = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (filled + value.byteLength > limit) {
          await reader.cancel().catch(() => {});
          this.hold(-filled);
          // A wrong-size chunk is a size error, not an overrun, unless it passes the chunk cap.
          return limit < CHUNK_SIZE_BYTES
            ? { bytes: new Uint8Array(limit + 1) }
            : { tooLarge: true };
        }
        buffer.set(value, filled);
        filled += value.byteLength;
        this.hold(value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
    return { bytes: buffer.subarray(0, filled) };
  }

  private hold(bytes: number) {
    this.bufferedBytes += bytes;
    this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes);
  }

  private release(read: ReadOutcome) {
    if ('bytes' in read) this.bufferedBytes -= Math.min(read.bytes.byteLength, this.bufferedBytes);
  }

  private dropHash() {
    this.hash = null;
    this.hashedThrough = -1;
  }

  complete(final?: { sha256: string; sizeBytes: number }): Promise<CompleteResult> {
    // Two completes at once share one verification.
    this.completing ??= this.exclusive(() => this.verify(final)).finally(() => {
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
    if (state.status === 'finalizing') return this.finalize(state);

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

    const count = chunkCountFor(sizeBytes);
    const computedSha256 =
      this.hash && this.hashedThrough === count ? this.hash.digest('hex') : null;
    this.dropHash();
    const finalizing: SessionState = {
      ...state,
      sha256,
      sizeBytes,
      status: 'finalizing',
      computedSha256,
    };
    await this.save(finalizing);
    return this.finalize(finalizing);
  }

  /**
   * Assembles and verifies the file. Safe to run again after a restart: when
   * the object already exists, R2 completed it earlier and only the check is
   * left. An upload is never failed for being "already completed".
   */
  private async finalize(state: SessionState): Promise<CompleteResult> {
    const sha256 = state.sha256!;
    const sizeBytes = state.sizeBytes!;
    let object = await this.storage.head(state.key);
    if (!object) {
      const parts = numbers(state).map((n) => ({ partNumber: n, etag: state.parts[n]!.etag }));
      try {
        object = await this.storage.completeUpload(state.key, state.uploadId, parts);
      } catch (error) {
        // A completion that landed while we were not looking.
        object = await this.storage.head(state.key);
        if (!object) throw error;
      }
    }
    if (object.size !== sizeBytes) {
      await this.storage.delete(state.key);
      return this.fail(
        state,
        'size_mismatch',
        `Stored ${object.size} bytes, expected ${sizeBytes}.`,
      );
    }
    const actual = state.computedSha256 ?? (await this.hashStored(state.key));
    if (actual !== sha256) {
      await this.storage.delete(state.key);
      return this.fail(state, 'hash_mismatch', 'The SHA-256 of the file does not match.');
    }
    await this.save({ ...state, status: 'confirmed' });
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
    const peakBufferedBytes = this.peakBufferedBytes;
    if (!state) {
      return {
        status: 'none',
        chunksReceived: [],
        chunkCount: null,
        failure: null,
        peakBufferedBytes,
      };
    }
    const open = state.status === 'uploading' || state.status === 'finalizing';
    return {
      status: state.status,
      chunksReceived: open ? numbers(state) : [],
      chunkCount: state.sizeBytes === null ? null : chunkCountFor(state.sizeBytes),
      failure: state.failure,
      peakBufferedBytes,
    };
  }

  abort(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.current();
      if (state?.status === 'uploading' || state?.status === 'finalizing') {
        await this.storage.abortUpload(state.key, state.uploadId).catch(() => {});
      }
      this.dropHash();
      this.state = undefined;
      await this.store.clear();
    });
  }

  /**
   * Called when the session's time is up. An upload still open after 7 days
   * is aborted and marked `session_expired` (returns true, so the caller can
   * update the recording); a finished session is forgotten. A session that
   * is finalizing is left for complete to finish.
   */
  expire(): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.current();
      if (!state) return false;
      if (state.status === 'uploading' && this.now() >= state.createdAt + SESSION_TTL_MS) {
        await this.storage.abortUpload(state.key, state.uploadId).catch(() => {});
        await this.fail(state, 'session_expired', 'The upload was not completed within 7 days.');
        return true;
      }
      if (state.status === 'confirmed' || state.status === 'failed') {
        this.state = undefined;
        await this.store.clear();
      }
      return false;
    });
  }
}
