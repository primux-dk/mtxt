/*
  ElevenLabs Scribe (docs/decisions.md, packet 11): synchronous, with
  speaker labels, through AI Gateway when the install has a gateway id and
  at api.elevenlabs.io otherwise.

  One multipart POST to /v1/speech-to-text: the stored file streamed from
  the install's own storage (never a public URL), Scribe v2, the install's
  language or detection, diarization, word timestamps, no audio events, and
  the keyterms as repeated `keyterms` fields. The answer comes back on the
  same request, so the job runs it like Workers AI, under its claim, with a
  10-minute deadline. Failures are the fixed reasons AssemblyAI uses.
*/
import { call, failure, readJson, type FetchFn } from './http';
import {
  SttError,
  type SttJob,
  type SttProvider,
  type SttResult,
  type SttSegment,
  type SttSpeaker,
  type SttWord,
} from './types';

export const ELEVENLABS_API = 'https://api.elevenlabs.io';
export const ELEVENLABS_MODEL = 'scribe_v2';
/** The whole call: upload, transcription and the answer (packet 11). */
export const ELEVENLABS_TIMEOUT_MS = 10 * 60_000;
/**
 * ElevenLabs' documented upload limits, checked 2026-10-23: "Files up to 3 GB"
 * and 10 hours on the Speech to Text overview (the API reference says under
 * 5.0 GB; the smaller holds).
 */
export const ELEVENLABS_MAX_BYTES = 3_000_000_000;
export const ELEVENLABS_MAX_SECONDS = 10 * 3600;
/** A pause longer than this starts a new segment, even for the same speaker. */
export const PAUSE_MS = 1200;

/** Keyterm rules from the API reference (2026-10-23). */
const MAX_TERMS = 1000;
const MAX_TERM_CHARS = 49; // "must be less than 50 characters"
const MAX_TERM_WORDS = 5;
const BAD_TERM_CHARS = /[<>{}[\]\\]/;

/** The keyterms Scribe accepts: under 50 characters, at most 5 words, none of <>{}[]\, 1,000 at most. */
export function scribeKeyterms(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ');
    if (!term || term.length > MAX_TERM_CHARS || BAD_TERM_CHARS.test(term)) continue;
    if (term.split(' ').length > MAX_TERM_WORDS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === MAX_TERMS) break;
  }
  return out;
}

/** The form fields besides the file, in order. `keyterms` repeats, one field per term. */
export function scribeFields(job: Pick<SttJob, 'language' | 'keyterms'>): [string, string][] {
  return [
    ['model_id', ELEVENLABS_MODEL],
    ...(job.language === 'auto' ? [] : ([['language_code', job.language]] as [string, string][])),
    ['diarize', 'true'],
    ['timestamps_granularity', 'word'],
    ['tag_audio_events', 'false'],
    ...scribeKeyterms(job.keyterms).map((t): [string, string] => ['keyterms', t]),
  ];
}

/** The endpoint: under the gateway's ElevenLabs path when there is one, else ElevenLabs' own API. */
export function scribeUrl(gatewayBase: string | null | undefined): string {
  return `${(gatewayBase || ELEVENLABS_API).replace(/\/$/, '')}/v1/speech-to-text`;
}

interface ElWord {
  text?: string;
  start?: number | null;
  end?: number | null;
  type?: 'word' | 'spacing' | 'audio_event' | string;
  speaker_id?: string | null;
  logprob?: number;
}
export interface ElTranscript {
  language_code?: string | null;
  language_probability?: number | null;
  text?: string | null;
  words?: ElWord[] | null;
  transcription_id?: string | null;
  audio_duration_secs?: number | null;
}

/** Scribe answers ISO 639-3 ("dan"); the result shape is ISO 639-1 where one exists. */
const ISO3: Record<string, string> = {
  ara: 'ar',
  ces: 'cs',
  cmn: 'zh',
  dan: 'da',
  deu: 'de',
  ell: 'el',
  eng: 'en',
  est: 'et',
  fao: 'fo',
  fin: 'fi',
  fra: 'fr',
  heb: 'he',
  hin: 'hi',
  hun: 'hu',
  isl: 'is',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  lav: 'lv',
  lit: 'lt',
  nld: 'nl',
  nno: 'nn',
  nob: 'nb',
  nor: 'no',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rus: 'ru',
  spa: 'es',
  swe: 'sv',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
  zho: 'zh',
};
export const iso1 = (code: string | null | undefined) => {
  const c = (code ?? '').trim().toLowerCase();
  return ISO3[c] ?? c;
};

/**
 * Scribe's answer as the one result shape. Speakers are numbered in the order
 * they first speak (`speaker_0`, `speaker_1`... as Scribe names them, which
 * need not start at 0). A segment is a run of one speaker's words with no
 * pause over 1.2 s; the spacing tokens between words are kept, so the text
 * reads as Scribe wrote it. Audio events are left out. The answer's `text` is
 * used only when it has no tokens at all.
 */
export function mapElevenLabs(json: ElTranscript, requestedLanguage: string): SttResult {
  const index = new Map<string, number>();
  const speakerOf = (id: string | null | undefined) => {
    const key = id ?? '?';
    if (!index.has(key)) index.set(key, index.size);
    return index.get(key)!;
  };
  const ms = (seconds: number | null | undefined) => Math.max(0, Math.round((seconds ?? 0) * 1000));

  const segments: SttSegment[] = [];
  const words: SttWord[] = [];
  let open: { speaker: number; startMs: number; endMs: number; parts: string[] } | null = null;
  const close = () => {
    const text = open?.parts.join('').replace(/\s+/g, ' ').trim();
    if (open && text) {
      segments.push({ startMs: open.startMs, endMs: open.endMs, text, speaker: open.speaker });
    }
    open = null;
  };
  for (const token of json.words ?? []) {
    const text = token.text ?? '';
    if (token.type === 'audio_event') continue;
    if (token.type === 'spacing') {
      open?.parts.push(text);
      continue;
    }
    if (!text.trim()) continue;
    const startMs = ms(token.start);
    const endMs = Math.max(startMs, ms(token.end));
    const speaker = speakerOf(token.speaker_id);
    if (!open || open.speaker !== speaker || startMs - open.endMs > PAUSE_MS) {
      close();
      open = { speaker, startMs, endMs, parts: [text] };
    } else {
      open.parts.push(text);
      open.endMs = Math.max(open.endMs, endMs);
    }
    words.push({
      startMs,
      endMs,
      text: text.trim(),
      ...(token.speaker_id ? { speaker } : {}),
    });
  }
  close();
  // Only an answer with no tokens at all falls back to its text: one with tokens
  // but no words (audio events only) has no speech, whatever `text` says.
  if (!json.words?.length && json.text?.trim()) {
    segments.push({
      startMs: 0,
      endMs: ms(json.audio_duration_secs),
      text: json.text.trim(),
      speaker: speakerOf(null),
    });
  }
  const speakers: SttSpeaker[] = [...index.values()].map((i) => ({ index: i, label: null }));
  return {
    language: iso1(json.language_code) || (requestedLanguage === 'auto' ? '' : requestedLanguage),
    model: ELEVENLABS_MODEL,
    segments,
    speakers,
    ...(words.length ? { words } : {}),
    raw: json,
  };
}

/** A content type safe to put in a part header; anything else is sent as octet-stream. */
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/**
 * The multipart body as a stream: the fields, the file part's head, the
 * stored audio as it is read, and the closing boundary. The length is known
 * from the recording's size, so in a Worker the body goes out with a
 * Content-Length (FixedLengthStream) instead of chunked; a stored file of
 * another size fails the request rather than sending a short body.
 */
export function multipartBody(
  fields: readonly [string, string][],
  file: { contentType: string; sizeBytes: number; stream: ReadableStream<Uint8Array> },
) {
  const boundary = `mtxt-${crypto.randomUUID()}`;
  const type = MIME.test(file.contentType) ? file.contentType : 'application/octet-stream';
  const ext = EXTENSIONS[type.toLowerCase()] ?? 'bin';
  const encoder = new TextEncoder();
  const head = encoder.encode(
    fields
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value.replace(/[\r\n]+/g, ' ')}\r\n`,
      )
      .join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.${ext}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const length = head.byteLength + file.sizeBytes + tail.byteLength;

  const reader = file.stream.getReader();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.enqueue(tail);
        controller.close();
      } else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
    .FixedLengthStream;
  let body: ReadableStream<Uint8Array> = stream;
  if (Fixed) {
    const fixed = new Fixed(length);
    // A size mismatch errors the readable side, which fails the request; nothing else to catch here.
    stream.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable as ReadableStream<Uint8Array>;
  }
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` };
}

export function elevenLabs(options: {
  apiKey: string;
  /** AI Gateway's ElevenLabs base (`…/{account}/{gateway}/elevenlabs`), or null for the direct API. */
  gatewayBase?: string | null;
  /** Test only: a fake's base URL in place of either. */
  baseUrl?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}): SttProvider {
  const url = options.baseUrl
    ? `${options.baseUrl.replace(/\/$/, '')}/v1/speech-to-text`
    : scribeUrl(options.gatewayBase);
  const fetchFn: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const what = options.gatewayBase ? 'ElevenLabs through AI Gateway' : 'ElevenLabs';
  return {
    describe: () => ({
      id: 'elevenlabs',
      model: ELEVENLABS_MODEL,
      supports: {
        diarization: true,
        keyterms: true,
        languages: 'auto',
        maxAudioBytes: ELEVENLABS_MAX_BYTES,
        maxAudioSeconds: ELEVENLABS_MAX_SECONDS,
      },
    }),
    async submit(job: SttJob) {
      if (job.sizeBytes > ELEVENLABS_MAX_BYTES || job.durationS > ELEVENLABS_MAX_SECONDS) {
        throw new SttError('stt_too_long', 'too_long', false, undefined, 'ElevenLabs');
      }
      const multipart = multipartBody(scribeFields(job), {
        contentType: job.contentType,
        sizeBytes: job.sizeBytes,
        stream: await job.audio(),
      });
      const response = await call(
        fetchFn,
        url,
        {
          method: 'POST',
          headers: {
            'xi-api-key': options.apiKey,
            'content-type': multipart.contentType,
          },
          body: multipart.body,
          // Streams the stored file without holding it in memory.
          duplex: 'half',
        } as RequestInit,
        what,
        options.timeoutMs ?? ELEVENLABS_TIMEOUT_MS,
      );
      if (!response.ok) {
        // The body is left unread; it may echo the request. Cancelling frees the connection.
        await response.body?.cancel().catch(() => {});
        throw failure(response.status, what);
      }
      const body = await readJson<ElTranscript>(response, what);
      if (!body || typeof body !== 'object' || !('text' in body || 'words' in body)) {
        throw new SttError('stt_failed', 'provider_error', true, response.status, what);
      }
      return { kind: 'done', result: mapElevenLabs(body, job.language) } as const;
    },
  };
}
