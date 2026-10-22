/**
 * Resumable upload sessions, one per recording (docs/spec.md "How a recording
 * reaches the library"). A session tracks which chunks arrived, streams each
 * one into a multipart upload, and verifies size and SHA-256 at complete.
 *
 * Cloudflare runs each session in a Durable Object; a Docker edition can run
 * the same logic in process with its state in the database.
 */

export interface UploadSessionInit {
  recordingId: string;
  installId: string;
  meetingId: string;
  /** Storage key of the finished file. */
  key: string;
  contentType: string;
  /** Null when the recorder is still producing the file; complete carries them. */
  sizeBytes: number | null;
  sha256: string | null;
}

export type ChunkResult =
  | { ok: true; n: number; sizeBytes: number; chunksReceived: number[]; chunkCount: number | null }
  | { ok: false; code: 'chunk_size' | 'too_large' | 'not_uploading' | 'busy'; message: string };

export type CompleteResult =
  | { ok: true; sha256: string; sizeBytes: number }
  | { ok: false; code: 'missing_chunks'; message: string; missing: number[] }
  | {
      ok: false;
      code:
        'invalid_request' | 'not_uploading' | 'hash_mismatch' | 'size_mismatch' | 'session_expired';
      message: string;
    };

export interface SessionStatus {
  /** `finalizing`: every chunk is in, the file is being assembled and verified. */
  status: 'uploading' | 'finalizing' | 'confirmed' | 'failed' | 'none';
  chunksReceived: number[];
  chunkCount: number | null;
  failure: string | null;
  /** The most chunk bytes the session has held in memory at once. */
  peakBufferedBytes: number;
}

export interface UploadSession {
  /** Idempotent: a session that exists is left alone. */
  begin(init: UploadSessionInit): Promise<void>;
  /**
   * One chunk. The body is read only after the session accepts it, and only
   * up to one chunk: one more byte and the read stops with `too_large`. While
   * another chunk is being received, written or verified, the answer is
   * `busy` and the body is not read.
   */
  putChunk(n: number, body: ReadableStream<Uint8Array> | ArrayBuffer | null): Promise<ChunkResult>;
  complete(final?: { sha256: string; sizeBytes: number }): Promise<CompleteResult>;
  status(): Promise<SessionStatus>;
  /** Stops an unfinished upload and forgets the session. The finished file is not touched. */
  abort(): Promise<void>;
}

export interface UploadSessions {
  get(recordingId: string): UploadSession;
}
