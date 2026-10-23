/*
  AssemblyAI, EU endpoint, async with a webhook (docs/decisions.md, packet 4).
  Called directly: AI Gateway does not front AssemblyAI (spec).

  The audio goes up through /v2/upload from the install's own storage, never
  through a public URL. The job asks for speaker labels, Universal-3.5 Pro with
  an explicit Universal-2 fallback, the install's language or detection, and
  the keyterms as `keyterms_prompt`. AssemblyAI calls the webhook with the
  install's secret in a custom header when the job is done.
*/
import {
  SttError,
  type Fetched,
  type SttDescription,
  type SttJob,
  type SttProvider,
  type SttResult,
  type SttSegment,
  type SttSpeaker,
  type SttWord,
  type Submitted,
} from './types';

export const ASSEMBLYAI_EU = 'https://api.eu.assemblyai.com';
export const ASSEMBLYAI_WEBHOOK_HEADER = 'X-Mtxt-Webhook-Secret';
export const ASSEMBLYAI_MODELS = ['universal-3-5-pro', 'universal-2'] as const;
/** Universal-3.5 Pro's 18 async languages (checked 2026-10-23); keyterms take 1,000 terms there. */
export const U3_LANGUAGES = [
  'ar',
  'da',
  'nl',
  'en',
  'fi',
  'fr',
  'de',
  'he',
  'hi',
  'it',
  'ja',
  'zh',
  'no',
  'nb',
  'pt',
  'es',
  'sv',
  'tr',
  'vi',
];
/** Universal-2 takes 200 terms; with detection either model may run, so the smaller cap holds. */
export const KEYTERM_LIMIT = { u3: 1000, u2: 200 } as const;
const MAX_TERM_WORDS = 6;

/** The keyterms AssemblyAI accepts for this language: at most 6 words each, capped per model. */
export function keytermsFor(terms: readonly string[], language: string): string[] {
  const cap = U3_LANGUAGES.includes(language) ? KEYTERM_LIMIT.u3 : KEYTERM_LIMIT.u2;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.trim().replace(/\s+/g, ' ');
    if (!term || term.split(' ').length > MAX_TERM_WORDS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === cap) break;
  }
  return out;
}

/** The transcript request body (POST /v2/transcript). */
export function transcriptRequest(
  job: Pick<SttJob, 'language' | 'keyterms'>,
  audioUrl: string,
  webhook: { url: string; secret: string },
) {
  const terms = keytermsFor(job.keyterms, job.language);
  return {
    audio_url: audioUrl,
    speech_models: [...ASSEMBLYAI_MODELS],
    speaker_labels: true,
    ...(job.language === 'auto' ? { language_detection: true } : { language_code: job.language }),
    ...(terms.length ? { keyterms_prompt: terms } : {}),
    webhook_url: webhook.url,
    webhook_auth_header_name: ASSEMBLYAI_WEBHOOK_HEADER,
    webhook_auth_header_value: webhook.secret,
  };
}

interface AaiWord {
  text?: string;
  start?: number;
  end?: number;
  speaker?: string | null;
}
interface AaiUtterance extends AaiWord {
  words?: AaiWord[];
}
export interface AaiTranscript {
  id?: string;
  status?: string;
  error?: string | null;
  text?: string | null;
  language_code?: string | null;
  speech_model_used?: string | null;
  utterances?: AaiUtterance[] | null;
  words?: AaiWord[] | null;
}

/**
 * AssemblyAI's finished transcript as the one result shape. Speakers are
 * numbered in the order they first speak (AssemblyAI's A, B, C...), and an
 * utterance is a segment. A transcript without utterances (no speaker
 * labels came back) becomes one segment, or none when there is no text.
 */
export function mapAssemblyAi(json: AaiTranscript, requestedLanguage: string): SttResult {
  const index = new Map<string, number>();
  const speakerOf = (label: string | null | undefined) => {
    const key = label ?? '?';
    if (!index.has(key)) index.set(key, index.size);
    return index.get(key)!;
  };
  const ms = (value: number | undefined) => Math.max(0, Math.round(value ?? 0));

  let segments: SttSegment[] = [];
  for (const u of json.utterances ?? []) {
    const text = (u.text ?? '').trim();
    if (!text) continue;
    segments.push({ startMs: ms(u.start), endMs: ms(u.end), text, speaker: speakerOf(u.speaker) });
  }
  if (!json.utterances?.length && json.text?.trim()) {
    const words = json.words ?? [];
    segments = [
      {
        startMs: ms(words[0]?.start),
        endMs: ms(words.at(-1)?.end),
        text: json.text.trim(),
        speaker: speakerOf(null),
      },
    ];
  }
  const words: SttWord[] | undefined = json.words?.length
    ? json.words.map((w) => ({
        startMs: ms(w.start),
        endMs: ms(w.end),
        text: w.text ?? '',
        ...(w.speaker ? { speaker: speakerOf(w.speaker) } : {}),
      }))
    : undefined;
  const speakers: SttSpeaker[] = [...index.values()].map((i) => ({ index: i, label: null }));
  return {
    language: json.language_code || (requestedLanguage === 'auto' ? '' : requestedLanguage),
    model: json.speech_model_used || ASSEMBLYAI_MODELS[0],
    segments,
    speakers,
    ...(words ? { words } : {}),
    raw: json,
  };
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Deadlines per call (docs/decisions.md, packet 4 review). */
export const ASSEMBLYAI_TIMEOUTS = { uploadMs: 10 * 60_000, requestMs: 60_000 };

/** An HTTP failure as a fixed reason. The body is not read: it may echo the request. */
export function failure(status: number, call: string): SttError {
  if (status === 401 || status === 403)
    return new SttError('stt_auth', 'unauthorised', false, status, call);
  if (status === 429) return new SttError('stt_failed', 'rate_limited', true, status, call);
  if (status >= 500) return new SttError('stt_failed', 'provider_error', true, status, call);
  if ([400, 413, 415, 422].includes(status)) {
    return new SttError('stt_failed', 'bad_audio', false, status, call);
  }
  return new SttError('stt_failed', 'provider_error', false, status, call);
}

/** AssemblyAI's `error` text on a failed transcript, reduced to a reason and never kept. */
export const reasonForError = (text: string | null | undefined) =>
  /audio|file|decod|duration|short|corrupt|format|codec|silence/i.test(text ?? '')
    ? ('bad_audio' as const)
    : ('provider_error' as const);

/** One call under a deadline. A network error or the deadline is worth another try. */
async function call(fetchFn: FetchFn, url: string, init: RequestInit, what: string, ms: number) {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SttError('stt_failed', 'timeout', true, undefined, what);
    }
    throw new SttError('stt_failed', 'provider_error', true, undefined, what);
  }
}

export function assemblyAi(options: {
  apiKey: string;
  webhook: { url: string; secret: string };
  baseUrl?: string;
  fetch?: FetchFn;
  timeouts?: Partial<typeof ASSEMBLYAI_TIMEOUTS>;
}): SttProvider {
  const timeouts = { ...ASSEMBLYAI_TIMEOUTS, ...options.timeouts };
  const base = (options.baseUrl ?? ASSEMBLYAI_EU).replace(/\/$/, '');
  const fetchFn: FetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const auth = { authorization: options.apiKey };
  // Only the language a job asks for is known at fetch time; detection fills it in.
  const languages = new Map<string, string>();

  const describe = (): SttDescription => ({
    id: 'assemblyai',
    model: ASSEMBLYAI_MODELS[0],
    supports: { diarization: true, keyterms: true, languages: 'auto' },
  });

  return {
    describe,
    async submit(job: SttJob): Promise<Submitted> {
      const upload = await call(
        fetchFn,
        `${base}/v2/upload`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          body: await job.audio(),
          // Streams the stored file without holding it in memory.
          duplex: 'half',
        } as RequestInit,
        'AssemblyAI upload',
        timeouts.uploadMs,
      );
      if (!upload.ok) throw failure(upload.status, 'AssemblyAI upload');
      const { upload_url: audioUrl } = (await upload.json()) as { upload_url?: string };
      if (!audioUrl) {
        throw new SttError('stt_failed', 'provider_error', true, undefined, 'AssemblyAI upload');
      }

      const created = await call(
        fetchFn,
        `${base}/v2/transcript`,
        {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify(transcriptRequest(job, audioUrl, options.webhook)),
        },
        'AssemblyAI transcript',
        timeouts.requestMs,
      );
      if (!created.ok) throw failure(created.status, 'AssemblyAI transcript');
      const body = (await created.json()) as AaiTranscript;
      if (!body.id) {
        throw new SttError(
          'stt_failed',
          'provider_error',
          true,
          undefined,
          'AssemblyAI transcript',
        );
      }
      languages.set(body.id, job.language);
      return { kind: 'pending', handle: body.id };
    },
    async fetch(handle: string): Promise<Fetched> {
      const response = await call(
        fetchFn,
        `${base}/v2/transcript/${encodeURIComponent(handle)}`,
        { headers: auth },
        'AssemblyAI transcript',
        timeouts.requestMs,
      );
      if (!response.ok) throw failure(response.status, 'AssemblyAI transcript');
      const body = (await response.json()) as AaiTranscript;
      if (body.status === 'completed') {
        return { kind: 'done', result: mapAssemblyAi(body, languages.get(handle) ?? 'auto') };
      }
      if (body.status === 'error') return { kind: 'failed', reason: reasonForError(body.error) };
      return { kind: 'pending', handle };
    },
  };
}
