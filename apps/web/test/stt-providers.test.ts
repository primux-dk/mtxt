import { describe, expect, it, vi } from 'vitest';
import type { SpeechModels } from '@mtxt/adapters';
import {
  ASSEMBLYAI_EU,
  ASSEMBLYAI_WEBHOOK_HEADER,
  assemblyAi,
  keytermsFor,
  mapAssemblyAi,
  transcriptRequest,
  type AaiTranscript,
} from '../lib/stt/assemblyai';
import fixture from '../lib/stt/fixtures/assemblyai-3-speakers.json';
import whisper from '../lib/stt/fixtures/whisper.json';
import { providerFor, SttError } from '../lib/stt';
import {
  mapWhisper,
  WHISPER_MAX_BYTES,
  whisperPrompt,
  workersAiWhisper,
} from '../lib/stt/workers-ai';
import { seal } from '@mtxt/adapters';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('AssemblyAI mapper', () => {
  const result = mapAssemblyAi(fixture as AaiTranscript, 'da');

  it('numbers three speakers in the order they first speak', () => {
    expect(result.speakers).toEqual([
      { index: 0, label: null },
      { index: 1, label: null },
      { index: 2, label: null },
    ]);
    expect(result.segments.map((s) => s.speaker)).toEqual([0, 1, 2, 0, 2]);
  });

  it('turns utterances into segments in milliseconds, with words', () => {
    expect(result.segments[1]).toEqual({
      startMs: 18000,
      endMs: 35200,
      text: 'Vi nåede de 240 enheder i går. Vi mangler stadig at teste det nye skift, før vi ændrer planen.',
      speaker: 1,
    });
    expect(result.words?.length).toBe(fixture.words.length);
    expect(result.language).toBe('da');
    expect(result.model).toBe('universal-3-5-pro');
    expect(result.raw).toBe(fixture);
  });

  it('keeps a transcript without utterances as one segment, and none without text', () => {
    const plain = mapAssemblyAi({ text: 'Hej', words: [{ start: 100, end: 900 }] }, 'auto');
    expect(plain.segments).toEqual([{ startMs: 100, endMs: 900, text: 'Hej', speaker: 0 }]);
    expect(plain.language).toBe('');
    const empty = mapAssemblyAi({ text: '', utterances: [] }, 'da');
    expect(empty.segments).toEqual([]);
    expect(empty.speakers).toEqual([]);
  });
});

describe('AssemblyAI request', () => {
  it('asks for speaker labels, Universal-3.5 Pro with Universal-2 as fallback, and the webhook header', () => {
    const body = transcriptRequest({ language: 'da', keyterms: ['linje 2'] }, 'u', {
      url: 'https://x/api/v1/webhooks/assemblyai',
      secret: 's',
    });
    expect(body).toEqual({
      audio_url: 'u',
      speech_models: ['universal-3-5-pro', 'universal-2'],
      speaker_labels: true,
      language_code: 'da',
      keyterms_prompt: ['linje 2'],
      webhook_url: 'https://x/api/v1/webhooks/assemblyai',
      webhook_auth_header_name: ASSEMBLYAI_WEBHOOK_HEADER,
      webhook_auth_header_value: 's',
    });
  });

  it('detects the language when the install says auto, and leaves out an empty keyterm list', () => {
    const body = transcriptRequest({ language: 'auto', keyterms: [] }, 'u', {
      url: 'w',
      secret: 's',
    });
    expect(body).toMatchObject({ language_detection: true });
    expect(body).not.toHaveProperty('language_code');
    expect(body).not.toHaveProperty('keyterms_prompt');
  });

  it('keeps keyterms of at most 6 words, without duplicates, 1,000 for Danish and 200 for detection', () => {
    expect(keytermsFor(['a b c d e f g', ' Ærø ', 'ærø', 'linje  2'], 'da')).toEqual([
      'Ærø',
      'linje 2',
    ]);
    const many = Array.from({ length: 1500 }, (_, i) => `term${i}`);
    expect(keytermsFor(many, 'da')).toHaveLength(1000);
    expect(keytermsFor(many, 'auto')).toHaveLength(200);
    expect(keytermsFor(many, 'is')).toHaveLength(200);
  });

  it('uploads, submits and fetches against the EU endpoint with the key, never in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v2/upload')) return Response.json({ upload_url: 'https://cdn/u1' });
      if (url.endsWith('/v2/transcript')) return Response.json({ id: 'tr1', status: 'queued' });
      return Response.json({ ...fixture, id: 'tr1' });
    });
    const provider = assemblyAi({
      apiKey: 'k-123',
      webhook: { url: 'w', secret: 's' },
      fetch: fetchFn,
    });
    const submitted = await provider.submit({
      recordingId: 'r',
      contentType: 'audio/webm',
      sizeBytes: 3,
      durationS: 1,
      language: 'da',
      keyterms: [],
      audio: async () => new Response('abc').body!,
    });
    expect(submitted).toEqual({ kind: 'pending', handle: 'tr1' });
    expect(calls.map((c) => c.url)).toEqual([
      `${ASSEMBLYAI_EU}/v2/upload`,
      `${ASSEMBLYAI_EU}/v2/transcript`,
    ]);
    expect(calls.every((c) => !c.url.includes('k-123'))).toBe(true);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('k-123');
    const fetched = await provider.fetch!('tr1');
    expect(fetched.kind).toBe('done');
  });

  it('fails a bad key at once and retries a 5xx', async () => {
    const provider = (status: number) =>
      assemblyAi({
        apiKey: 'k',
        webhook: { url: 'w', secret: 's' },
        fetch: async () => Response.json({ error: 'nope' }, { status }),
      });
    const job = {
      recordingId: 'r',
      contentType: 'audio/webm',
      sizeBytes: 1,
      durationS: 1,
      language: 'da',
      keyterms: [],
      audio: async () => new Response('a').body!,
    };
    await expect(provider(401).submit(job)).rejects.toMatchObject({
      code: 'stt_auth',
      retryable: false,
    });
    await expect(provider(503).submit(job)).rejects.toMatchObject({
      code: 'stt_failed',
      retryable: true,
    });
    await expect(provider(400).fetch!('x')).rejects.toMatchObject({ retryable: false });
  });

  it('reports a provider error with its own words', async () => {
    const provider = assemblyAi({
      apiKey: 'k',
      webhook: { url: 'w', secret: 's' },
      fetch: async () => Response.json({ id: 'x', status: 'error', error: 'Audio is too short' }),
    });
    expect(await provider.fetch!('x')).toEqual({ kind: 'failed', reason: 'Audio is too short' });
  });
});

describe('Workers AI Whisper', () => {
  it('maps segments to one speaker, in milliseconds, without the WebVTT copy', () => {
    const result = mapWhisper(whisper, 'auto', '@cf/openai/whisper-large-v3-turbo');
    expect(result.speakers).toEqual([{ index: 0, label: null }]);
    expect(result.segments).toEqual([
      {
        startMs: 0,
        endMs: 5600,
        text: 'Så er vi samlet. Lad os begynde med kapaciteten på linje 2.',
        speaker: 0,
      },
      { startMs: 6000, endMs: 12400, text: 'Vi nåede de 240 enheder i går.', speaker: 0 },
    ]);
    expect(result.language).toBe('da');
    expect((result.raw as { vtt?: string }).vtt).toBeUndefined();
  });

  it('maps no speech to no segments and no speakers', () => {
    expect(mapWhisper({ text: '' }, 'da', 'm')).toMatchObject({
      segments: [],
      speakers: [],
      language: 'da',
    });
  });

  it('refuses a file over the limit with the too-long code, before reading it', async () => {
    const speech: SpeechModels = { whisperModel: 'm', whisper: vi.fn() };
    const audio = vi.fn();
    const provider = workersAiWhisper({ speech });
    await expect(
      provider.submit({
        recordingId: 'r',
        contentType: 'audio/webm',
        sizeBytes: WHISPER_MAX_BYTES + 1,
        durationS: 1,
        language: 'da',
        keyterms: [],
        audio,
      }),
    ).rejects.toMatchObject({ code: 'stt_too_long', retryable: false });
    expect(audio).not.toHaveBeenCalled();
    expect(speech.whisper).not.toHaveBeenCalled();
  });

  it('sends the language, the keyterms as a prompt and the gateway id', async () => {
    const whisperFn = vi.fn(async () => whisper);
    const provider = workersAiWhisper({
      speech: { whisperModel: 'm', whisper: whisperFn },
      gatewayId: 'gw',
    });
    const out = await provider.submit({
      recordingId: 'r',
      contentType: 'audio/webm',
      sizeBytes: 3,
      durationS: 1,
      language: 'da',
      keyterms: ['linje 2', 'Ærø'],
      audio: async () => new Response('abc').body!,
    });
    expect(out.kind).toBe('done');
    expect(whisperFn).toHaveBeenCalledWith({
      audio: new Uint8Array([97, 98, 99]),
      language: 'da',
      initialPrompt: 'linje 2, Ærø',
      gatewayId: 'gw',
    });
  });

  it('cuts the prompt at a whole term', () => {
    const prompt = whisperPrompt(Array.from({ length: 200 }, (_, i) => `term${i}`))!;
    expect(prompt.length).toBeLessThanOrEqual(600);
    expect(prompt.endsWith(',')).toBe(false);
  });
});

describe('providerFor', () => {
  const speech: SpeechModels = { whisperModel: 'm', whisper: vi.fn() };
  const base = {
    settingsKey: KEY,
    speech,
    publicUrl: 'https://m.example.com',
    webhookSecret: async () => '',
  };

  it('refuses no provider and the ones this version does not have', async () => {
    await expect(
      providerFor({ sttProvider: null, sttApiKey: null, aiGatewayId: null }, base),
    ).rejects.toMatchObject({ code: 'stt_no_provider' });
    await expect(
      providerFor({ sttProvider: 'azure', sttApiKey: null, aiGatewayId: null }, base),
    ).rejects.toMatchObject({ code: 'stt_unavailable' });
  });

  it('opens the key and the webhook secret at call time and points the webhook at the install', async () => {
    const apiKey = await seal('k-1', 'settings.stt_api_key', KEY);
    const secret = await seal('w-1', 'settings.webhook_secret', KEY);
    const seen: string[] = [];
    const provider = await providerFor(
      { sttProvider: 'assemblyai', sttApiKey: apiKey, aiGatewayId: null },
      {
        ...base,
        webhookSecret: async () => secret,
        fetch: async (url, init) => {
          seen.push(url);
          if (url.endsWith('/upload')) return Response.json({ upload_url: 'u' });
          const body = JSON.parse(String(init!.body)) as Record<string, string>;
          expect(body.webhook_url).toBe('https://m.example.com/api/v1/webhooks/assemblyai');
          expect(body.webhook_auth_header_value).toBe('w-1');
          expect((init!.headers as Record<string, string>).authorization).toBe('k-1');
          return Response.json({ id: 't' });
        },
      },
    );
    expect(provider.describe().id).toBe('assemblyai');
    await provider.submit({
      recordingId: 'r',
      contentType: 'audio/webm',
      sizeBytes: 1,
      durationS: 1,
      language: 'da',
      keyterms: [],
      audio: async () => new Response('a').body!,
    });
    expect(seen).toHaveLength(2);
  });

  it('fails with a config error when a secret does not open', async () => {
    await expect(
      providerFor(
        { sttProvider: 'assemblyai', sttApiKey: 'v1.bad.value', aiGatewayId: null },
        base,
      ),
    ).rejects.toBeInstanceOf(SttError);
  });
});
