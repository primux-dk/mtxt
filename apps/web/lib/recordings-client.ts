/**
 * The browser's side of the recorder contract (packages/contract): the same
 * four calls the desktop recorder makes, used by the file upload and the
 * browser recorder. Nothing here is server code.
 */
import {
  CHUNK_SIZE_BYTES,
  MAX_RECORDING_BYTES,
  type ApiError,
  type ChunkReceipt,
  type CompleteRecordingRequest,
  type CreateRecordingRequest,
  type CreateRecordingResponse,
  type Recording,
} from '@mtxt/contract';
import { createSha256, sha256OfBlob } from './sha256';

const BASE = '/api/v1/recordings';

/**
 * What went wrong, sorted by what the user does next (behaviour.md rule 9):
 * `network` retry, `mismatch` start over, `disabled` and `rejected` ask the
 * admin.
 */
export type UploadErrorKind = 'network' | 'mismatch' | 'disabled' | 'tooLarge' | 'rejected';

export class UploadError extends Error {
  constructor(
    readonly kind: UploadErrorKind,
    readonly code: string,
    readonly status?: number,
    readonly missing?: number[],
  ) {
    super(`${kind}: ${code}`);
    this.name = 'UploadError';
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' });
  } catch {
    throw new UploadError('network', 'offline');
  }
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as
    (ApiError & { missing?: number[] }) | null;
  const code = body?.error?.code ?? `http_${response.status}`;
  if (response.status >= 500 || response.status === 429) {
    throw new UploadError('network', code, response.status);
  }
  const kind: UploadErrorKind =
    code === 'hash_mismatch' || code === 'size_mismatch' || code === 'session_expired'
      ? 'mismatch'
      : code === 'source_disabled'
        ? 'disabled'
        : code === 'too_large'
          ? 'tooLarge'
          : 'rejected';
  throw new UploadError(kind, code, response.status, body?.missing);
}

export const recordingsApi = {
  create: (body: CreateRecordingRequest) =>
    call<CreateRecordingResponse>(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  putChunk: (id: string, n: number, bytes: Blob) =>
    call<ChunkReceipt>(`${BASE}/${id}/chunks/${n}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    }),
  complete: (id: string, body?: CompleteRecordingRequest) =>
    call<Recording>(`${BASE}/${id}/complete`, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  get: (id: string) => call<Recording>(`${BASE}/${id}`, { method: 'GET' }),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries network failures with backoff (1, 2, 4, 8 s, then every 15 s) up
 * to `attempts`, telling the caller each time so it can say "retrying".
 * Every other error is final. Every call it wraps is safe to repeat.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  { attempts = 5, onRetry }: { attempts?: number; onRetry?: (attempt: number) => void } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof UploadError) || error.kind !== 'network' || attempt >= attempts) {
        throw error;
      }
      onRetry?.(attempt);
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    }
  }
}

export const chunkCount = (size: number) => Math.ceil(size / CHUNK_SIZE_BYTES);
export const chunkOf = (blob: Blob, n: number) =>
  blob.slice((n - 1) * CHUNK_SIZE_BYTES, n * CHUNK_SIZE_BYTES);

/** Whole seconds of audio in a file, or 0 when the browser cannot tell (WebM often cannot). */
export function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (seconds: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    setTimeout(() => done(0), 10_000);
    audio.src = url;
  });
}

export function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  // Some systems report no type for .m4a or .opus files.
  return !file.type && /\.(m4a|mp3|wav|ogg|oga|opus|webm|flac|aac|wma|amr)$/i.test(file.name);
}

export function checkFile(file: File): 'notAudio' | 'tooLarge' | 'empty' | null {
  if (!isAudioFile(file)) return 'notAudio';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_RECORDING_BYTES) return 'tooLarge';
  return null;
}

/* ---- File upload with resume ---- */

/** What survives a reload, in localStorage, keyed by file name and size. */
export interface SavedUpload {
  recording_id: string;
  meeting_id: string;
  sha256: string;
  chunks_done: number[];
}

const resumeKey = (file: File) => `mtxt.upload:${file.name}:${file.size}`;

export const savedUploads = {
  get(file: File): SavedUpload | null {
    try {
      const raw = localStorage.getItem(resumeKey(file));
      return raw ? (JSON.parse(raw) as SavedUpload) : null;
    } catch {
      return null;
    }
  },
  set(file: File, value: SavedUpload) {
    try {
      localStorage.setItem(resumeKey(file), JSON.stringify(value));
    } catch {
      // Storage full or blocked: the upload still works, it just cannot resume.
    }
  },
  clear(file: File) {
    try {
      localStorage.removeItem(resumeKey(file));
    } catch {}
  },
};

export type UploadProgress =
  | { phase: 'hashing'; done: number; total: number }
  | { phase: 'uploading'; done: number; total: number }
  | { phase: 'verifying' }
  | { phase: 'retrying'; attempt: number };

/**
 * Uploads a file: hash, create, chunks, complete. With `resume`, asks the
 * server which chunks it holds and sends only the rest. Returns the meeting.
 */
export async function uploadFile(
  file: File,
  target: { title: string } | { meetingId: string },
  onProgress: (progress: UploadProgress) => void,
  resume?: SavedUpload,
): Promise<{ meetingId: string; recordingId: string }> {
  const total = chunkCount(file.size);
  const onRetry = (attempt: number) => onProgress({ phase: 'retrying', attempt });
  let saved = resume;
  let received = new Set<number>();

  if (saved) {
    try {
      const recording = await withRetry(() => recordingsApi.get(saved!.recording_id), { onRetry });
      if (recording.status !== 'uploading' && recording.confirmed_at) {
        savedUploads.clear(file);
        return { meetingId: recording.meeting_id, recordingId: recording.id };
      }
      if (recording.status === 'uploading') received = new Set(recording.chunks_received);
      else saved = undefined;
    } catch (error) {
      if (!(error instanceof UploadError) || error.kind === 'network') throw error;
      saved = undefined;
    }
    if (!saved) savedUploads.clear(file);
  }

  if (!saved) {
    const sha256 = await sha256OfBlob(file, (done) =>
      onProgress({ phase: 'hashing', done, total: file.size }),
    );
    const details = {
      duration_s: await audioDuration(file),
      sha256,
      size_bytes: file.size,
      source: 'upload' as const,
      content_type: file.type || 'application/octet-stream',
    };
    const created = await withRetry(
      () =>
        recordingsApi.create(
          'meetingId' in target
            ? { ...details, meeting_id: target.meetingId }
            : {
                ...details,
                meeting: {
                  title: target.title,
                  started_at: new Date(file.lastModified || Date.now()).toISOString(),
                },
              },
        ),
      { onRetry },
    );
    saved = { recording_id: created.id, meeting_id: created.meeting_id, sha256, chunks_done: [] };
    savedUploads.set(file, saved);
  }

  const current = saved;
  for (let n = 1; n <= total; n++) {
    onProgress({ phase: 'uploading', done: received.size, total });
    if (received.has(n)) continue;
    const receipt = await withRetry(
      () => recordingsApi.putChunk(current.recording_id, n, chunkOf(file, n)),
      {
        onRetry,
      },
    );
    received = new Set(receipt.chunks_received);
    savedUploads.set(file, { ...current, chunks_done: receipt.chunks_received });
  }
  onProgress({ phase: 'uploading', done: total, total });
  onProgress({ phase: 'verifying' });
  try {
    await withRetry(() => recordingsApi.complete(current.recording_id), { onRetry });
  } catch (error) {
    // A mismatch deleted the server's copy: the saved state is useless now.
    if (error instanceof UploadError && error.kind === 'mismatch') savedUploads.clear(file);
    throw error;
  }
  savedUploads.clear(file);
  return { meetingId: current.meeting_id, recordingId: current.recording_id };
}

/* ---- Streaming upload for the browser recorder ---- */

/**
 * Uploads a recording while it is being made. MediaRecorder hands over small
 * pieces; they are hashed in order and kept in one growing list, and each
 * time 8 MB have gathered that chunk is sent. stop() sends the rest and
 * completes with the final size and hash. The pieces stay in memory until
 * the server confirms, so a failed upload can be sent again.
 */
export class StreamingUpload {
  private readonly pieces: Blob[] = [];
  private readonly hash = createSha256();
  private size = 0;
  private sent = 0;
  private hashing: Promise<void> = Promise.resolve();
  private sending: Promise<void> = Promise.resolve();
  private created: Promise<CreateRecordingResponse> | null = null;
  private failure: unknown = null;
  private digest: string | null = null;
  confirmed = false;

  constructor(
    private readonly meeting: { title: string; startedAt: Date },
    private readonly contentType: string,
    private readonly events: {
      onSent?: (chunks: number) => void;
      onRetry?: (attempt: number) => void;
    } = {},
  ) {}

  /** Creates the recording on the server. Retries quietly; recording does not wait for it. */
  start() {
    this.created = withRetry(
      () =>
        recordingsApi.create({
          meeting: { title: this.meeting.title, started_at: this.meeting.startedAt.toISOString() },
          duration_s: 0,
          source: 'browser',
          content_type: this.contentType,
        }),
      { attempts: 8, onRetry: this.events.onRetry },
    );
    this.created.catch((error) => (this.failure = error));
  }

  get meetingId(): Promise<string | null> {
    return this.created?.then((c) => c.meeting_id).catch(() => null) ?? Promise.resolve(null);
  }

  /** One piece from MediaRecorder's dataavailable. */
  add(piece: Blob) {
    if (piece.size === 0) return;
    this.pieces.push(piece);
    this.size += piece.size;
    this.hashing = this.hashing.then(async () => {
      this.hash.update(new Uint8Array(await piece.arrayBuffer()));
    });
    while (this.size - this.sent * CHUNK_SIZE_BYTES >= CHUNK_SIZE_BYTES) {
      this.queueChunk(++this.sent);
    }
  }

  private whole() {
    return new Blob(this.pieces, { type: this.contentType });
  }

  private queueChunk(n: number) {
    this.sending = this.sending.then(async () => {
      if (this.failure) return;
      try {
        const { id } = await this.created!;
        const bytes = chunkOf(this.whole(), n);
        await withRetry(() => recordingsApi.putChunk(id, n, bytes), {
          attempts: 8,
          onRetry: this.events.onRetry,
        });
        this.events.onSent?.(n);
      } catch (error) {
        this.failure = error;
      }
    });
  }

  /**
   * After MediaRecorder's final dataavailable: sends the last chunk and
   * completes. Throws when the upload cannot finish; call it again to retry,
   * it resends only what the server lacks.
   */
  async finish(durationS: number): Promise<{ meetingId: string }> {
    await this.hashing;
    await this.sending;
    if (!this.created) throw new UploadError('rejected', 'not_started');
    if (this.failure) {
      // Try again. If the recording was never created, create it now; the
      // chunks the server lacks are sent below either way.
      this.failure = null;
      if (
        !(await this.created.then(
          () => true,
          () => false,
        ))
      )
        this.start();
    }
    const { id, meeting_id } = await this.created;
    const total = chunkCount(this.size);
    const whole = this.whole();
    const have = new Set((await withRetry(() => recordingsApi.get(id))).chunks_received);
    for (let n = 1; n <= total; n++) {
      if (have.has(n)) continue;
      await withRetry(() => recordingsApi.putChunk(id, n, chunkOf(whole, n)), {
        onRetry: this.events.onRetry,
      });
      this.events.onSent?.(n);
    }
    // A digest can be taken once; a retry reuses it.
    const sha256 = (this.digest ??= this.hash.hex());
    await withRetry(() =>
      recordingsApi.complete(id, { sha256, size_bytes: this.size, duration_s: durationS }),
    );
    this.confirmed = true;
    // Confirmed: the server holds it, the tab can let go.
    this.pieces.length = 0;
    return { meetingId: meeting_id };
  }
}
