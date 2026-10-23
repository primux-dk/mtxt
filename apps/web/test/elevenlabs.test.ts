import { describe, expect, it, vi } from 'vitest';
import { describeError, redact, seal, type SpeechModels } from '@mtxt/adapters';
import { providerFor, SttError, type SttJob } from '../lib/stt';
import {
  ELEVENLABS_API,
  ELEVENLABS_MAX_BYTES,
  ELEVENLABS_MAX_SECONDS,
  ELEVENLABS_TIMEOUT_MS,
  elevenLabs,
  iso1,
  mapElevenLabs,
  multipartBody,
  scribeFields,
  scribeKeyterms,
  scribeUrl,
  type ElTranscript,
} from '../lib/stt/elevenlabs';
import fixture from '../lib/stt/fixtures/elevenlabs-2-speakers.json';

const KEY = Buffer.alloc(32, 7).toString('base64');

const job = (over: Partial<SttJob> = {}): SttJob => ({
  recordingId: 'r',
  contentType: 'audio/ogg',
  sizeBytes: 3,
  durationS: 1,
  language: 'da',
  keyterms: [],
  audio: async () => new Response('abc').body!,
  ...over,
});

/** A fetch that records each call and reads the multipart body back. */
function recording(answer: () => Response = () => Response.json(fixture)) {
  const calls: { url: string; headers: Record<string, string>; form: FormData }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    const form = await new Response(init!.body, {
      headers: { 'content-type': headers['content-type']! },
    }).formData();
    calls.push({ url, headers, form });
    return answer();
  });
  return { calls, fetchFn };
}

describe('ElevenLabs mapper', () => {
  const result = mapElevenLabs(fixture as ElTranscript, 'auto');

  it('splits on a new speaker and on a pause over 1.2 s, numbering two speakers', () => {
    expect(result.speakers).toEqual([
      { index: 0, label: null },
      { index: 1, label: null },
    ]);
    expect(result.segments).toEqual([
      {
        startMs: 240,
        endMs: 3840,
        text: 'Godmorgen alle sammen. Lad os tage linje 2 først.',
        speaker: 0,
      },
      { startMs: 4400, endMs: 6800, text: 'Vi nåede de 240 enheder i går.', speaker: 1 },
      // 2.1 s after the last word: the same speaker, a new segment.
      { startMs: 8900, endMs: 10140, text: 'Ugeplanen holder.', speaker: 1 },
      { startMs: 10620, endMs: 12860, text: 'Godt, så tager vi Ærø bagefter.', speaker: 0 },
    ]);
  });

  it('keeps the words with their speakers, the language as ISO 639-1, the model and the raw answer', () => {
    expect(result.words).toHaveLength(fixture.words.filter((w) => w.type === 'word').length);
    expect(result.words![0]).toEqual({ startMs: 240, endMs: 810, text: 'Godmorgen', speaker: 0 });
    expect(result.words!.at(-1)).toEqual({
      startMs: 12080,
      endMs: 12860,
      text: 'bagefter.',
      speaker: 0,
    });
    expect(result.language).toBe('da');
    expect(result.model).toBe('scribe_v2');
    expect(result.raw).toBe(fixture);
  });

  it('numbers speakers by first speech, whatever Scribe calls them, and leaves audio events out', () => {
    const out = mapElevenLabs(
      {
        language_code: 'eng',
        words: [
          { text: 'Hi', start: 0, end: 0.4, type: 'word', speaker_id: 'speaker_3' },
          { text: '(laughter)', start: 0.5, end: 1, type: 'audio_event', speaker_id: 'speaker_3' },
          { text: ' ', start: 1, end: 1.1, type: 'spacing', speaker_id: 'speaker_3' },
          { text: 'there', start: 1.1, end: 1.4, type: 'word', speaker_id: 'speaker_3' },
          { text: ' ', start: 1.4, end: 1.5, type: 'spacing', speaker_id: 'speaker_1' },
          { text: 'Hello', start: 1.5, end: 2, type: 'word', speaker_id: 'speaker_1' },
        ],
      },
      'auto',
    );
    expect(out.segments).toEqual([
      { startMs: 0, endMs: 1400, text: 'Hi there', speaker: 0 },
      { startMs: 1500, endMs: 2000, text: 'Hello', speaker: 1 },
    ]);
    expect(out.language).toBe('en');
  });

  it('keeps text without words as one segment, and no speech as none', () => {
    const plain = mapElevenLabs({ text: 'Hej', audio_duration_secs: 2.5 }, 'da');
    expect(plain.segments).toEqual([{ startMs: 0, endMs: 2500, text: 'Hej', speaker: 0 }]);
    expect(plain.language).toBe('da');
    const empty = mapElevenLabs({ text: '', words: [] }, 'auto');
    expect(empty.segments).toEqual([]);
    expect(empty.speakers).toEqual([]);
    expect(empty.language).toBe('');
  });

  it('turns ISO 639-3 into 639-1 and leaves a code it does not know', () => {
    expect(iso1('dan')).toBe('da');
    expect(iso1('nob')).toBe('nb');
    expect(iso1('da')).toBe('da');
    expect(iso1('kal')).toBe('kal');
    expect(iso1(null)).toBe('');
  });
});

describe('ElevenLabs request', () => {
  it('asks for Scribe v2, the language, diarization, word timestamps, no audio events and the keyterms', () => {
    expect(scribeFields({ language: 'da', keyterms: ['linje 2', 'Ærø'] })).toEqual([
      ['model_id', 'scribe_v2'],
      ['language_code', 'da'],
      ['diarize', 'true'],
      ['timestamps_granularity', 'word'],
      ['tag_audio_events', 'false'],
      ['keyterms', 'linje 2'],
      ['keyterms', 'Ærø'],
    ]);
  });

  it('leaves the language out for detection', () => {
    const fields = scribeFields({ language: 'auto', keyterms: [] });
    expect(fields.map(([name]) => name)).toEqual([
      'model_id',
      'diarize',
      'timestamps_granularity',
      'tag_audio_events',
    ]);
  });

  it('keeps keyterms Scribe takes: under 50 characters, 5 words, no brackets, no duplicates, 1,000', () => {
    expect(
      scribeKeyterms([
        ' linje  2 ',
        'LINJE 2',
        'a'.repeat(49),
        'a'.repeat(50),
        'en to tre fire fem',
        'en to tre fire fem seks',
        'Ærø <ø>',
        'x[1]',
        'back\\slash',
        '',
      ]),
    ).toEqual(['linje 2', 'a'.repeat(49), 'en to tre fire fem']);
    expect(scribeKeyterms(Array.from({ length: 1200 }, (_, i) => `t${i}`))).toHaveLength(1000);
  });

  it('builds a multipart body of the stated length with the file streamed in', async () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const part = multipartBody(
      [
        ['model_id', 'scribe_v2'],
        ['keyterms', 'a'],
        ['keyterms', 'b'],
      ],
      { contentType: 'audio/ogg', sizeBytes: audio.byteLength, stream: new Response(audio).body! },
    );
    const bytes = new Uint8Array(await new Response(part.body).arrayBuffer());
    expect(bytes.byteLength).toBe(part.length);
    const form = await new Response(bytes, {
      headers: { 'content-type': part.contentType },
    }).formData();
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.getAll('keyterms')).toEqual(['a', 'b']);
    const file = form.get('file') as File;
    expect(file.name).toBe('recording.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
  });

  it('sends an unknown or unsafe content type as octet-stream', async () => {
    const part = multipartBody([], {
      contentType: 'audio/ogg\r\nX-Evil: 1',
      sizeBytes: 1,
      stream: new Response('a').body!,
    });
    const text = await new Response(part.body).text();
    expect(text).toContain('Content-Type: application/octet-stream');
    expect(text).not.toContain('X-Evil');
  });
});

describe('ElevenLabs URL forms', () => {
  it('posts to ElevenLabs directly, or under the gateway’s ElevenLabs path', () => {
    expect(scribeUrl(null)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(scribeUrl('https://gateway.ai.cloudflare.com/v1/acc123/mtxt-gateway/elevenlabs/')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/mtxt-gateway/elevenlabs/v1/speech-to-text',
    );
  });

  const speech: SpeechModels = { whisperModel: 'm', whisper: vi.fn() };
  const deps = { settingsKey: KEY, speech, publicUrl: undefined, webhookSecret: async () => '' };

  it('goes through AI Gateway when the install has a gateway id, with the key in xi-api-key', async () => {
    const apiKey = await seal('xi-key-1', 'settings.stt_api_key', KEY);
    const gatewayUrl = vi.fn(
      async (id: string, provider: string) =>
        `https://gateway.ai.cloudflare.com/v1/acc123/${id}/${provider}`,
    );
    const { calls, fetchFn } = recording();
    const provider = await providerFor(
      { sttProvider: 'elevenlabs', sttApiKey: apiKey, aiGatewayId: 'mtxt-gateway' },
      { ...deps, gatewayUrl, fetch: fetchFn },
    );
    expect(provider.describe()).toMatchObject({ id: 'elevenlabs', model: 'scribe_v2' });
    const out = await provider.submit(job({ keyterms: ['linje 2'] }));
    expect(gatewayUrl).toHaveBeenCalledWith('mtxt-gateway', 'elevenlabs');
    expect(calls[0]!.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acc123/mtxt-gateway/elevenlabs/v1/speech-to-text',
    );
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-key-1');
    expect(calls[0]!.url).not.toContain('xi-key-1');
    expect(calls[0]!.form.getAll('keyterms')).toEqual(['linje 2']);
    expect(out.kind === 'done' && out.result.segments).toHaveLength(4);
  });

  it('calls ElevenLabs directly without a gateway id, and needs no PUBLIC_URL', async () => {
    const apiKey = await seal('xi-key-2', 'settings.stt_api_key', KEY);
    const gatewayUrl = vi.fn();
    const { calls, fetchFn } = recording();
    const provider = await providerFor(
      { sttProvider: 'elevenlabs', sttApiKey: apiKey, aiGatewayId: null },
      { ...deps, gatewayUrl, fetch: fetchFn },
    );
    await provider.submit(job());
    expect(gatewayUrl).not.toHaveBeenCalled();
    expect(calls[0]!.url).toBe(`${ELEVENLABS_API}/v1/speech-to-text`);
    expect(calls[0]!.headers['xi-api-key']).toBe('xi-key-2');
  });

  it('fails with a config error when the gateway address cannot be had, and an auth error without a key', async () => {
    const apiKey = await seal('xi-key-3', 'settings.stt_api_key', KEY);
    await expect(
      providerFor(
        { sttProvider: 'elevenlabs', sttApiKey: apiKey, aiGatewayId: 'gw' },
        {
          ...deps,
          gatewayUrl: async () => {
            throw new Error('This Worker has no AI binding.');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'stt_config', retryable: false });
    await expect(
      providerFor({ sttProvider: 'elevenlabs', sttApiKey: null, aiGatewayId: null }, deps),
    ).rejects.toMatchObject({ code: 'stt_auth' });
  });
});

describe('ElevenLabs limits and failures', () => {
  it('refuses a file over 3 GB or 10 hours with the too-long code, before reading it', async () => {
    const fetchFn = vi.fn();
    const provider = elevenLabs({ apiKey: 'k', fetch: fetchFn });
    for (const over of [
      { sizeBytes: ELEVENLABS_MAX_BYTES + 1 },
      { durationS: ELEVENLABS_MAX_SECONDS + 1 },
    ]) {
      const audio = vi.fn();
      await expect(provider.submit(job({ ...over, audio }))).rejects.toMatchObject({
        code: 'stt_too_long',
        reason: 'too_long',
        retryable: false,
      });
      expect(audio).not.toHaveBeenCalled();
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(provider.describe().supports).toMatchObject({
      diarization: true,
      maxAudioBytes: 3_000_000_000,
      maxAudioSeconds: 36_000,
    });
  });

  it('maps statuses to fixed reasons with the status, without the body', async () => {
    const message = async (status: number) =>
      elevenLabs({
        apiKey: 'k',
        fetch: async () => Response.json({ detail: { message: 'secret-ish body' } }, { status }),
      })
        .submit(job())
        .catch((e: SttError) => [e.code, e.stored, e.retryable]);
    expect(await message(401)).toEqual(['stt_auth', 'unauthorised:401', false]);
    expect(await message(422)).toEqual(['stt_failed', 'bad_audio:422', false]);
    expect(await message(429)).toEqual(['stt_failed', 'rate_limited:429', true]);
    expect(await message(503)).toEqual(['stt_failed', 'provider_error:503', true]);
  });

  it('never carries the key from an error body into the error, the stored reason or the log line', async () => {
    const secret = 'xi-redaction-key-123';
    const apiKey = await seal(secret, 'settings.stt_api_key', KEY);
    const echo = (status: number, body: string) => async (_url: string, init?: RequestInit) => {
      const key = (init!.headers as Record<string, string>)['xi-api-key'];
      return new Response(body.replace('KEY', key!), { status });
    };
    for (const [status, body] of [
      [401, '{"detail":{"status":"invalid_api_key","message":"Invalid key KEY"}}'],
      [200, '{"words": KEY <html>'],
    ] as const) {
      const provider = await providerFor(
        { sttProvider: 'elevenlabs', sttApiKey: apiKey, aiGatewayId: null },
        {
          settingsKey: KEY,
          speech: { whisperModel: 'm', whisper: vi.fn() },
          publicUrl: undefined,
          webhookSecret: async () => '',
          fetch: echo(status, body),
        },
      );
      const error = (await provider.submit(job()).catch((e) => e)) as SttError;
      expect(error).toBeInstanceOf(SttError);
      expect(error.stored).toBe(status === 401 ? 'unauthorised:401' : 'provider_error:200');
      for (const text of [error.message, error.stored, describeError(error), String(error)]) {
        expect(text).not.toContain(secret);
      }
    }
    // The opened key is remembered, so even a raw line that carries it is redacted.
    expect(redact(`xi-api-key: ${secret}`)).not.toContain(secret);
    expect(redact('xi-api-key: some-other-value')).toBe('xi-api-key: [redacted]');
  });

  it('runs the call under a 10-minute deadline; past it, a retryable timeout', async () => {
    expect(ELEVENLABS_TIMEOUT_MS).toBe(600_000);
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
      });
    const provider = elevenLabs({ apiKey: 'k', fetch: hang, timeoutMs: 20 });
    await expect(provider.submit(job())).rejects.toMatchObject({
      reason: 'timeout',
      retryable: true,
      call: 'ElevenLabs',
    });
  });
});
