import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seal, type Job, type QueueAdapter, type StorageAdapter } from '@mtxt/adapters';
import { mapAssemblyAi, type AaiTranscript } from '../lib/stt/assemblyai';
import fixture from '../lib/stt/fixtures/assemblyai-3-speakers.json';
import { SttError, type SttProvider } from '../lib/stt';
import { runTranscribe, type TranscribeDeps } from '../lib/transcription/job';
import { planSpeakers, unnamedNumber } from '../lib/transcription/speakers';
import { nextStep, webhookWakes } from '../lib/transcription/state';
import { assemblyAiWebhook, secretMatches } from '../lib/transcription/webhook';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

const KEY = Buffer.alloc(32, 3).toString('base64');
const RESULT = mapAssemblyAi(fixture as AaiTranscript, 'da');

describe('the state machine', () => {
  it('submits, fetches, finishes or skips by status and transcript row', () => {
    expect(nextStep('confirmed', null)).toBe('submit');
    expect(nextStep('transcribing', { status: 'pending', providerJobId: null })).toBe('submit');
    expect(nextStep('transcribing', { status: 'pending', providerJobId: 'x' })).toBe('fetch');
    expect(nextStep('transcribing', { status: 'done', providerJobId: 'x' })).toBe('finish');
    expect(nextStep('transcribing', { status: 'failed', providerJobId: 'x' })).toBe('submit');
    for (const status of ['transcribed', 'failed', 'uploading'] as const) {
      expect(nextStep(status, null)).toBe('skip');
    }
  });

  it('wakes on a webhook only for a pending, real transcript', () => {
    expect(webhookWakes({ status: 'pending', isComparison: false })).toBe(true);
    expect(webhookWakes({ status: 'done', isComparison: false })).toBe(false);
    expect(webhookWakes({ status: 'pending', isComparison: true })).toBe(false);
    expect(webhookWakes(undefined)).toBe(false);
  });
});

describe('speaker labels', () => {
  it('reuses the meeting row for the same number and adds the rest as Speaker n', () => {
    const plan = planSpeakers(
      [
        { id: 's0', speakerIndex: 0 },
        { id: 'manual', speakerIndex: null },
      ],
      [
        { index: 0, label: null },
        { index: 1, label: null },
        { index: 2, label: 'Anne' },
      ],
    );
    expect([...plan.reuse]).toEqual([[0, 's0']]);
    expect(plan.create).toEqual([
      { speakerIndex: 1, label: 'Speaker 2' },
      { speakerIndex: 2, label: 'Anne' },
    ]);
  });

  it('tells a default label from a name', () => {
    expect(unnamedNumber('Speaker 3')).toBe(3);
    expect(unnamedNumber('Søren Bak')).toBeNull();
  });
});

function harness(provider: Partial<SttProvider> & Pick<SttProvider, 'submit'>) {
  const sent: Job[] = [];
  const queue: QueueAdapter = {
    send: async (job) => void sent.push(job),
    sendBatch: async () => {},
  };
  const storage = {
    get: async () => ({ key: 'k', size: 3, body: new Response('abc').body! }),
  } as unknown as StorageAdapter;
  const full: SttProvider = {
    describe: () => ({
      id: 'assemblyai',
      model: 'universal-3-pro',
      supports: { diarization: true, keyterms: true, languages: 'auto' },
    }),
    ...provider,
  };
  return { sent, queue, storage, provider: full };
}

describe('the transcribe job', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  const log = { log: vi.fn(), error: vi.fn() };
  beforeEach(async () => {
    ctx = await testDb();
    seedRecording(ctx.raw);
    ctx.raw.exec(`INSERT INTO settings (install_id, product_name, language, stt_provider)
      VALUES ('${INSTALL}', 'M', 'da', 'assemblyai');
      INSERT INTO keyterms (id, install_id, term, boost) VALUES ('k1', '${INSTALL}', 'ugeplan', 1),
        ('k2', '${INSTALL}', 'linje 2', 3);`);
  });
  const deps = (h: ReturnType<typeof harness>): TranscribeDeps => ({
    db: ctx.db,
    installId: INSTALL,
    storage: h.storage,
    queue: h.queue,
    provider: async () => h.provider,
    log,
  });
  const rows = (sql: string) => ctx.raw.prepare(sql).all() as Record<string, unknown>[];

  it('runs a synchronous provider to transcribed, with speakers, segments and a recap job', async () => {
    const submit = vi.fn(async () => ({ kind: 'done' as const, result: RESULT }));
    const h = harness({ submit });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect((submit.mock.calls as unknown as [unknown][])[0]![0]).toMatchObject({
      language: 'da',
      keyterms: ['linje 2', 'ugeplan'],
    });
    expect(rows(`select status, failure from recordings`)).toEqual([
      { status: 'transcribed', failure: null },
    ]);
    expect(rows(`select label, speaker_index from speakers order by speaker_index`)).toEqual([
      { label: 'Speaker 1', speaker_index: 0 },
      { label: 'Speaker 2', speaker_index: 1 },
      { label: 'Speaker 3', speaker_index: 2 },
    ]);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 5 }]);
    expect(rows(`select status, language, provider from transcripts`)).toEqual([
      { status: 'done', language: 'da', provider: 'assemblyai' },
    ]);
    expect(h.sent).toEqual([{ type: 'recap', meeting_id: 'meet-1', install_id: INSTALL }]);
  });

  it('keeps a renamed speaker for a second recording of the same meeting', async () => {
    const h = harness({ submit: async () => ({ kind: 'done', result: RESULT }) });
    await runTranscribe(deps(h), 'rec-1', 1);
    ctx.raw.exec(`UPDATE speakers SET label = 'Mette Lund' WHERE speaker_index = 0`);
    seedRecording(ctx.raw, 'rec-2');
    await runTranscribe(deps(h), 'rec-2', 1);
    expect(rows(`select label from speakers order by speaker_index`).map((r) => r.label)).toEqual([
      'Mette Lund',
      'Speaker 2',
      'Speaker 3',
    ]);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 10 }]);
  });

  it('stores an async job id, then finishes when the webhook wakes it, once', async () => {
    const fetch = vi.fn(async () => ({ kind: 'done' as const, result: RESULT }));
    const h = harness({ submit: async () => ({ kind: 'pending', handle: 'aai-1' }), fetch });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, provider_job_id from transcripts`)).toEqual([
      { status: 'pending', provider_job_id: 'aai-1' },
    ]);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
    await runTranscribe(deps(h), 'rec-1', 1);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 5 }]);
    expect(rows(`select count(*) n from transcripts`)).toEqual([{ n: 1 }]);
  });

  it('heals a run that wrote the transcript but stopped before the status', async () => {
    const h = harness({ submit: async () => ({ kind: 'done', result: RESULT }) });
    let fail = true;
    h.queue.send = async (job) => {
      if (fail) throw new Error('queue down');
      h.sent.push(job);
    };
    await expect(runTranscribe(deps(h), 'rec-1', 1)).rejects.toThrow('queue down');
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
    fail = false;
    await runTranscribe(deps(h), 'rec-1', 2);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(h.sent).toHaveLength(1);
  });

  it('fails at once on an error that will not pass, with the code and the reason', async () => {
    const h = harness({
      submit: async () => {
        throw new SttError('stt_too_long', 'too big');
      },
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_too_long', failure_reason: 'too big' },
    ]);
    expect(rows(`select status from transcripts`)).toEqual([{ status: 'failed' }]);
  });

  it('retries a passing error twice, then fails on the third delivery', async () => {
    const h = harness({
      submit: async () => {
        throw new SttError('stt_failed', 'HTTP 503', true);
      },
    });
    await expect(runTranscribe(deps(h), 'rec-1', 1)).rejects.toThrow('HTTP 503');
    await expect(runTranscribe(deps(h), 'rec-1', 2)).rejects.toThrow('HTTP 503');
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
    await runTranscribe(deps(h), 'rec-1', 3);
    expect(rows(`select status, failure from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_failed' },
    ]);
  });

  it('records a provider-side error from the async job', async () => {
    const h = harness({
      submit: async () => ({ kind: 'pending', handle: 'aai-2' }),
      fetch: async () => ({ kind: 'failed', reason: 'Audio is too short' }),
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_failed', failure_reason: 'Audio is too short' },
    ]);
  });

  it('submits again after Try again, on the same transcript row', async () => {
    let n = 0;
    const h = harness({
      submit: async () => {
        if (n++ === 0) throw new SttError('stt_auth', 'bad key');
        return { kind: 'done', result: RESULT };
      },
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    ctx.raw.exec(
      `UPDATE recordings SET status = 'transcribing', failure = NULL, failure_reason = NULL`,
    );
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(rows(`select count(*) n from transcripts`)).toEqual([{ n: 1 }]);
  });

  it('writes a transcript with no speech as done with no segments', async () => {
    const h = harness({
      submit: async () => ({ kind: 'done', result: { ...RESULT, segments: [], speakers: [] } }),
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 0 }]);
  });

  it('writes 6,000 segments in a few statements', async () => {
    const segments = Array.from({ length: 6000 }, (_, i) => ({
      startMs: i * 2400,
      endMs: i * 2400 + 2000,
      text: `Sætning nummer ${i} om kapaciteten på linje 2, med æ, ø og å.`,
      speaker: i % 14,
    }));
    const speakers = Array.from({ length: 14 }, (_, i) => ({ index: i, label: null }));
    const h = harness({
      submit: async () => ({ kind: 'done', result: { ...RESULT, segments, speakers } }),
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 6000 }]);
    expect(rows(`select count(*) n from speakers`)).toEqual([{ n: 14 }]);
  });

  it('leaves a recording of another install alone', async () => {
    const h = harness({ submit: vi.fn() });
    await runTranscribe({ ...deps(h), installId: 'other' }, 'rec-1', 1);
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
  });
});

describe('the AssemblyAI webhook', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  let sealed: string;
  const sent: Job[] = [];
  const queue: QueueAdapter = {
    send: async (job) => void sent.push(job),
    sendBatch: async () => {},
  };
  beforeEach(async () => {
    ctx = await testDb();
    sent.length = 0;
    seedRecording(ctx.raw);
    sealed = await seal('the-secret', 'settings.webhook_secret', KEY);
    ctx.raw.exec(`INSERT INTO transcripts (id, install_id, recording_id, provider, model, language,
      raw_json, status, provider_job_id) VALUES ('t1', '${INSTALL}', 'rec-1', 'assemblyai', 'u3', '',
      '{}', 'pending', 'aai-1')`);
  });
  const call = (secret: string | null, body: unknown, installId = INSTALL) =>
    assemblyAiWebhook(
      new Request('https://m.example.com/api/v1/webhooks/assemblyai', {
        method: 'POST',
        headers: secret === null ? {} : { 'X-Mtxt-Webhook-Secret': secret },
        body: JSON.stringify(body),
      }),
      { db: ctx.db, installId, queue, settingsKey: KEY, sealedSecret: sealed },
    );

  it('refuses a wrong or missing secret with 401 and queues nothing', async () => {
    expect((await call('wrong', { transcript_id: 'aai-1' })).status).toBe(401);
    expect((await call(null, { transcript_id: 'aai-1' })).status).toBe(401);
    expect((await call('', { transcript_id: 'aai-1' })).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it('wakes the job for a pending transcript', async () => {
    const response = await call('the-secret', { transcript_id: 'aai-1', status: 'completed' });
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ type: 'transcribe', recording_id: 'rec-1', install_id: INSTALL }]);
  });

  it('acknowledges and ignores a replay for a finished transcript and an unknown id', async () => {
    ctx.raw.exec(`UPDATE transcripts SET status = 'done'`);
    const replay = await call('the-secret', { transcript_id: 'aai-1', status: 'completed' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, ignored: true });
    expect((await call('the-secret', { transcript_id: 'nope' })).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it('ignores a transcript of another install', async () => {
    expect((await call('the-secret', { transcript_id: 'aai-1' }, 'other')).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it('refuses a body without a transcript id', async () => {
    expect((await call('the-secret', {})).status).toBe(400);
  });

  it('compares secrets in full', async () => {
    expect(await secretMatches('abc', 'abc')).toBe(true);
    expect(await secretMatches('abd', 'abc')).toBe(false);
    expect(await secretMatches('', '')).toBe(false);
  });
});
