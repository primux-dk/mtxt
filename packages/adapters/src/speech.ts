/**
 * Speech models the platform runs itself rather than calling a provider's
 * API: Workers AI Whisper on Cloudflare. The app talks to this interface, so
 * apps/web never touches the `AI` binding, and a Docker edition can put a
 * local Whisper behind the same shape.
 */

/** Whisper's input, as Workers AI takes it. */
export interface WhisperInput {
  /** The whole file. Workers AI takes it base64-encoded, in memory. */
  audio: Uint8Array;
  /** ISO 639-1. Left out, the model detects the language. */
  language?: string;
  /** Context for the model: the install's keyterms, as a sentence. */
  initialPrompt?: string;
  /** AI Gateway id; the request goes through the gateway when set. */
  gatewayId?: string | null;
}

/** Whisper's output (the model's schema-output.json), the parts the app reads. */
export interface WhisperOutput {
  text: string;
  word_count?: number;
  transcription_info?: {
    language?: string;
    language_probability?: number;
    duration?: number;
    duration_after_vad?: number;
  };
  segments?: {
    start?: number;
    end?: number;
    text?: string;
    words?: { word?: string; start?: number; end?: number }[];
  }[];
  vtt?: string;
}

export interface SpeechModels {
  /** The model id, for the transcripts row. */
  readonly whisperModel: string;
  whisper(input: WhisperInput): Promise<WhisperOutput>;
}
