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
export type Fetched = Submitted | { kind: 'failed'; reason: string };

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

export interface SttProvider {
  describe(): SttDescription;
  submit(job: SttJob): Promise<Submitted>;
  /** For async providers: the job's state by its handle. */
  fetch?(handle: string): Promise<Fetched>;
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
 * A provider error. `retryable` ones (network, rate limits, the provider's
 * own 5xx) go back to the queue; the rest fail the recording at once.
 * `message` is the provider's own words, shown under the localised line;
 * it never holds a key.
 */
export class SttError extends Error {
  constructor(
    readonly code: SttFailure,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

export const isSttFailure = (code: string | null | undefined): code is SttFailure =>
  (STT_FAILURES as readonly string[]).includes(code ?? '');
