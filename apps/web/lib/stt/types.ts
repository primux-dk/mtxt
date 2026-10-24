/*
  The speech-to-text provider interface (docs/decisions.md, packet 4). A
  provider takes a recording and answers either with the finished result
  (a synchronous provider such as Workers AI) or with a handle to fetch it
  by later (an async one such as AssemblyAI, which calls the webhook when it
  is done). Every provider's answer maps to one result shape.

  Plain TypeScript with no Next.js imports: the queue consumer runs it
  outside the Next.js bundle.
*/
import type { SttProvider as SttProviderId } from '@mtxt/adapters';
import type { PieceLimits } from '../audio/plan';

export type { SttProviderId };

export interface SttSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Index into `speakers`, from 0. */
  speaker: number;
}

export interface SttSpeaker {
  index: number;
  /** A name the provider gave the speaker; null means "Speaker n". */
  label: string | null;
}

export interface SttWord {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: number;
}

export interface SttResult {
  /** ISO 639-1 where the provider says, else what was asked for. */
  language: string;
  /** The model that actually ran (AssemblyAI may route to another). */
  model: string;
  segments: SttSegment[];
  speakers: SttSpeaker[];
  words?: SttWord[];
  /** The provider's own response, stored whole in transcripts.raw_json. */
  raw: unknown;
}

export interface SttJob {
  recordingId: string;
  contentType: string;
  sizeBytes: number;
  durationS: number;
  /** The whole file, read when the provider needs it. */
  audio: () => Promise<ReadableStream<Uint8Array>>;
  /** An ISO code, or `auto` for language detection. */
  language: string;
  /** The install's keyterms, highest weight first. */
  keyterms: readonly string[];
}

export type Submitted = { kind: 'done'; result: SttResult } | { kind: 'pending'; handle: string };
export type Fetched = Submitted | { kind: 'failed'; reason: SttReason };

export interface SttDescription {
  id: SttProviderId;
  model: string;
  supports: {
    diarization: boolean;
    keyterms: boolean;
    /** `auto` means the provider detects the language itself. */
    languages: 'auto' | readonly string[];
    maxAudioBytes?: number;
    maxAudioSeconds?: number;
  };
}

/** One piece of a cut recording, a file of its own (lib/audio). */
export interface PieceInput {
  audio: Uint8Array;
  contentType: string;
  language: string;
  keyterms: readonly string[];
}

/**
 * A synchronous provider with a size ceiling can take a long recording in
 * pieces (docs/decisions.md, packet 18): the job cuts the file under
 * `limits`, sends the pieces one by one and stitches the results. A file
 * up to `wholeMaxBytes` still goes whole through `submit`.
 */
export interface PiecedTranscription {
  limits: PieceLimits & { wholeMaxBytes: number };
  /** The piece's result, its times from the piece's own start. */
  transcribePiece(input: PieceInput): Promise<SttResult>;
}

export interface SttProvider {
  describe(): SttDescription;
  submit(job: SttJob): Promise<Submitted>;
  /** For async providers: the job's state by its handle. */
  fetch?(handle: string): Promise<Fetched>;
  /** For a synchronous provider with a size ceiling: long recordings in pieces. */
  pieces?: PiecedTranscription;
}

/**
 * The failure codes stored in recordings.failure for a transcription
 * failure. The page says each in the reader's language (transcript.failure.*).
 */
export const STT_FAILURES = [
  'stt_failed',
  'stt_too_long',
  'stt_auth',
  'stt_no_provider',
  'stt_unavailable',
  'stt_config',
] as const;
export type SttFailure = (typeof STT_FAILURES)[number];

/**
 * What went wrong, from a fixed set. A provider's own words never reach a
 * log line or a row: they may echo the request, key and all. The page says
 * each kind in the reader's language (transcript.reason.*).
 */
export const STT_REASONS = [
  'unauthorised',
  'rate_limited',
  'bad_audio',
  'provider_error',
  'timeout',
  'too_long',
  'unsplittable',
  'missing_audio',
  'config',
  'internal',
] as const;
export type SttReason = (typeof STT_REASONS)[number];

/**
 * A provider error. `retryable` ones (network, rate limits, the provider's
 * own 5xx, a deadline) go back to the queue; the rest fail the recording at
 * once. The message is built from the fixed reason and the HTTP status only.
 */
export class SttError extends Error {
  constructor(
    readonly code: SttFailure,
    readonly reason: SttReason,
    readonly retryable = false,
    readonly status?: number,
    /** Which call failed, for the log: "AssemblyAI upload". */
    readonly call = 'Speech-to-text',
  ) {
    super(`${call}: ${reason}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'SttError';
  }

  /** What `recordings.failure_reason` stores: the reason and the status, nothing else. */
  get stored(): string {
    return this.status ? `${this.reason}:${this.status}` : this.reason;
  }
}

export const isSttFailure = (code: string | null | undefined): code is SttFailure =>
  (STT_FAILURES as readonly string[]).includes(code ?? '');

/** A stored `failure_reason`, read back: the reason kind and the HTTP status, if any. */
export function parseReason(stored: string | null | undefined) {
  const [kind, status] = (stored ?? '').split(':');
  if (!(STT_REASONS as readonly string[]).includes(kind ?? '')) return null;
  return { reason: kind as SttReason, status: status && /^\d{3}$/.test(status) ? status : null };
}
