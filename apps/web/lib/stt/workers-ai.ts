/*
  Workers AI Whisper (docs/decisions.md, packet 4): synchronous, no speaker
  labels, through AI Gateway when the install has a gateway id. The whole
  file goes to the model base64-encoded, in the Worker's memory, so a
  recording past the limit fails with a next step instead of being cut up;
  chunking is a later packet.
*/
import type { SpeechModels, WhisperOutput } from '@mtxt/adapters';
import { SttError, type SttJob, type SttProvider, type SttResult } from './types';

/**
 * The largest file sent. The model page states no limit (checked
 * 2026-10-22); the file is held in memory and base64-encoded (a third
 * larger) inside a Worker's 128 MB, so 25 MiB leaves room.
 */
export const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
/** The deadline on one Whisper call; the binding takes no signal, so the call races a timer. */
export const WHISPER_TIMEOUT_MS = 5 * 60_000;
/** Whisper's prompt is 224 tokens; keyterms past this length are left out. */
const PROMPT_CHARS = 600;

/** Keyterms as Whisper's initial prompt: a comma list, cut at a whole term. */
export function whisperPrompt(terms: readonly string[]): string | undefined {
  let prompt = '';
  for (const term of terms) {
    const next = prompt ? `${prompt}, ${term.trim()}` : term.trim();
    if (next.length > PROMPT_CHARS) break;
    prompt = next;
  }
  return prompt || undefined;
}

/** Whisper's output as the one result shape: every segment is "Speaker 1". */
export function mapWhisper(
  output: WhisperOutput,
  requestedLanguage: string,
  model: string,
): SttResult {
  const ms = (seconds: number | undefined) => Math.max(0, Math.round((seconds ?? 0) * 1000));
  let segments = (output.segments ?? [])
    .map((s) => ({
      startMs: ms(s.start),
      endMs: ms(s.end),
      text: (s.text ?? '').trim(),
      speaker: 0,
    }))
    .filter((s) => s.text);
  if (!segments.length && output.text?.trim()) {
    segments = [
      {
        startMs: 0,
        endMs: ms(output.transcription_info?.duration),
        text: output.text.trim(),
        speaker: 0,
      },
    ];
  }
  const words = (output.segments ?? []).flatMap((s) =>
    (s.words ?? []).map((w) => ({
      startMs: ms(w.start),
      endMs: ms(w.end),
      text: (w.word ?? '').trim(),
      speaker: 0,
    })),
  );
  return {
    language:
      output.transcription_info?.language ||
      (requestedLanguage === 'auto' ? '' : requestedLanguage),
    model,
    segments,
    speakers: segments.length ? [{ index: 0, label: null }] : [],
    ...(words.length ? { words } : {}),
    // The WebVTT copy repeats the segments; it is left out of the stored JSON.
    raw: { ...output, vtt: undefined },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) {
    size += part.byteLength;
    if (size > limit)
      throw new SttError('stt_too_long', 'too_long', false, undefined, 'Workers AI');
    parts.push(part);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A promise against a deadline: past it, a retryable timeout. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SttError('stt_failed', 'timeout', true, undefined, 'Workers AI')),
      ms,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function workersAiWhisper(options: {
  speech: SpeechModels;
  gatewayId?: string | null;
  timeoutMs?: number;
}): SttProvider {
  const model = options.speech.whisperModel;
  return {
    describe: () => ({
      id: 'workers-ai-whisper',
      model,
      supports: {
        diarization: false,
        keyterms: true,
        languages: 'auto',
        maxAudioBytes: WHISPER_MAX_BYTES,
      },
    }),
    async submit(job: SttJob) {
      if (job.sizeBytes > WHISPER_MAX_BYTES) {
        throw new SttError('stt_too_long', 'too_long', false, undefined, 'Workers AI');
      }
      const audio = await readAll(await job.audio(), WHISPER_MAX_BYTES);
      let output: WhisperOutput;
      try {
        output = await withDeadline(
          options.speech.whisper({
            audio,
            ...(job.language !== 'auto' ? { language: job.language } : {}),
            initialPrompt: whisperPrompt(job.keyterms),
            gatewayId: options.gatewayId ?? null,
          }),
          options.timeoutMs ?? WHISPER_TIMEOUT_MS,
        );
      } catch (error) {
        if (error instanceof SttError) throw error;
        // Workers AI's own text is not kept; a capacity or 5xx error is worth another try.
        const text = String((error as Error)?.message ?? '');
        throw new SttError(
          'stt_failed',
          'provider_error',
          /capacity|timeout|unavailable|5\d\d/i.test(text),
          undefined,
          'Workers AI',
        );
      }
      return { kind: 'done', result: mapWhisper(output, job.language, model) } as const;
    },
  };
}
