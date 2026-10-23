import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seal, type Job, type QueueAdapter, type StorageAdapter } from '@mtxt/adapters';
import { mapAssemblyAi, type AaiTranscript } from '../lib/stt/assemblyai';
import fixture from '../lib/stt/fixtures/assemblyai-3-speakers.json';
import { SttError, type SttProvider, type SttResult } from '../lib/stt';
import { MAX_ATTEMPTS, runTranscribe, type TranscribeDeps } from '../lib/transcription/job';
import { planSpeakers, unnamedNumber } from '../lib/transcription/speakers';
import { nextStep, webhookWakes } from '../lib/transcription/state';
import {
  CLAIM_LEASE_MS,
  claimTranscript,
  drainStep,
  ensureTranscript,
  MAX_D1_VALUE_BYTES,
  takeRecapJob,
} from '../lib/transcription/store';
import { assemblyAiWebhook, parseWebhook, secretMatches } from '../lib/transcription/webhook';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

const KEY = Buffer.alloc(32, 3).toString('base64');
const RESULT = mapAssemblyAi(fixture as AaiTranscript, 'da');

describe('the state machine', () => {
  it('submits, fetches, finishes or skips, and never resets a terminal row', () => {
    expect(nextStep('confirmed', null)).toBe('submit');
    expect(nextStep('transcribing', { status: 'pending', providerJobId: null })).toBe('submit');
    expect(nextStep('transcribing', { status: 'pending', providerJobId: 'x' })).toBe('fetch');
    expect(nextStep('transcribing', { status: 'done', providerJobId: 'x' })).toBe('finish');
    expect(nextStep('transcribing', { status: 'failed', providerJobId: 'x' })).toBe('skip');
    expect(
      nextStep('transcribed', { status: 'done', providerJobId: null, recapEnqueuedAt: null }),
    ).toBe('finish');
    expect(
      nextStep('transcribed', { status: 'done', providerJobId: null, recapEnqueuedAt: new Date() }),
    ).toBe('skip');
    for (const status of ['failed', 'uploading'] as const)
      expect(nextStep(status, null)).toBe('skip');
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

type Sent = { job: Job; delaySeconds?: number };

function harness(provider: Partial<SttProvider> & Pick<SttProvider, 'submit'>) {
  const sent: Sent[] = [];
  const queue: QueueAdapter = {
    send: async (job, options) => void sent.push({ job, delaySeconds: options?.delaySeconds }),
    sendBatch: async (jobs) => void sent.push(...jobs.map((j) => ({ job: j.body }))),
  };
  const stored = new Map<string, string>();
  const storage = {
    get: async () => ({ key: 'k', size: 3, body: new Response('abc').body! }),
    put: async (key: string, body: string) => {
      stored.set(key, body);
      return { key, size: body.length };
    },
  } as unknown as StorageAdapter;
  const full: SttProvider = {
    describe: () => ({
      id: 'assemblyai',
      model: 'universal-3-5-pro',
      supports: { diarization: true, keyterms: true, languages: 'auto' },
    }),
    ...provider,
  };
  const recaps = () => sent.filter((s) => s.job.type === 'recap');
  return { sent, recaps, queue, storage, stored, provider: full };
}

describe('the transcribe job', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  const log = { log: vi.fn(), error: vi.fn() };
  beforeEach(async () => {
    ctx = await testDb();
    log.log.mockClear();
    log.error.mockClear();
    seedRecording(ctx.raw);
    ctx.raw.exec(`INSERT INTO settings (install_id, product_name, language, stt_provider)
      VALUES ('${INSTALL}', 'M', 'da', 'assemblyai');
      INSERT INTO keyterms (id, install_id, term, boost) VALUES ('k1', '${INSTALL}', 'ugeplan', 1),
        ('k2', '${INSTALL}', 'linje 2', 3);`);
  });
  const deps = (
    h: ReturnType<typeof harness>,
    extra: Partial<TranscribeDeps> = {},
  ): TranscribeDeps => ({
    db: ctx.db,
    installId: INSTALL,
    storage: h.storage,
    queue: h.queue,
    provider: async () => h.provider,
    log,
    ...extra,
  });
  const rows = (sql: string) => ctx.raw.prepare(sql).all() as Record<string, unknown>[];

  it('runs a synchronous provider to transcribed: speakers, segments, raw result in storage, one recap job', async () => {
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
    const [row] = rows(
      `select id, status, language, raw_json, raw_path, claim_token from transcripts`,
    );
    expect(row).toMatchObject({
      status: 'done',
      language: 'da',
      raw_json: '{}',
      raw_path: 'transcripts/test-install/rec-1/assemblyai.json',
      claim_token: null,
    });
    expect(JSON.parse(h.stored.get('transcripts/test-install/rec-1/assemblyai.json')!)).toEqual(
      fixture,
    );
    expect(h.recaps().map((s) => s.job)).toEqual([
      { type: 'recap', meeting_id: 'meet-1', transcript_id: row!.id, install_id: INSTALL },
    ]);
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

  it('two concurrent deliveries make one submission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const submit = vi.fn(async () => {
      await gate;
      return { kind: 'done' as const, result: RESULT };
    });
    const h = harness({ submit });
    const first = runTranscribe(deps(h), 'rec-1', 1);
    const second = runTranscribe(deps(h), 'rec-1', 1);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.recaps()).toHaveLength(1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 5 }]);
  });

  it('a claim that has not expired keeps a redelivery out; an expired one is taken over', async () => {
    const submit = vi.fn(async () => ({ kind: 'done' as const, result: RESULT }));
    const h = harness({ submit });
    await ensureTranscript(ctx.db, INSTALL, 'rec-1', 'assemblyai', 'm');
    const old = new Date(Date.now() - CLAIM_LEASE_MS + 60_000);
    expect(await claimTranscript(ctx.db, INSTALL, 'rec-1', 'submit', {}, old)).not.toBeNull();
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(submit).not.toHaveBeenCalled();
    ctx.raw.exec(`UPDATE transcripts SET claimed_at = ${Date.now() - CLAIM_LEASE_MS - 1000}`);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
  });

  it('a completion that lands between the read and the claim is never reset', async () => {
    const submit = vi.fn();
    const h = harness({ submit });
    await ensureTranscript(ctx.db, INSTALL, 'rec-1', 'assemblyai', 'm');
    // The other delivery finishes while this one builds its provider.
    const provider = async () => {
      ctx.raw.exec(`UPDATE transcripts SET status = 'done', language = 'da'`);
      return h.provider;
    };
    await runTranscribe(deps(h, { provider }), 'rec-1', 1);
    expect(submit).not.toHaveBeenCalled();
    expect(rows(`select status, claim_token from transcripts`)).toEqual([
      { status: 'done', claim_token: null },
    ]);
  });

  it('a delivery whose claim was taken over writes nothing', async () => {
    const h = harness({
      submit: async () => {
        // A slow provider: meanwhile the claim expires and another delivery takes it.
        ctx.raw.exec(`UPDATE transcripts SET claim_token = 'someone-else'`);
        return { kind: 'done', result: RESULT };
      },
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 0 }]);
    expect(rows(`select status from transcripts`)).toEqual([{ status: 'pending' }]);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
    expect(h.recaps()).toHaveLength(0);
  });

  it('stores an async job id, lets the claim go, queues a delayed check, and finishes once when woken', async () => {
    const fetch = vi.fn(async () => ({ kind: 'done' as const, result: RESULT }));
    const h = harness({ submit: async () => ({ kind: 'pending', handle: 'aai-1' }), fetch });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, provider_job_id, claim_token from transcripts`)).toEqual([
      { status: 'pending', provider_job_id: 'aai-1', claim_token: null },
    ]);
    expect(h.sent).toEqual([
      {
        job: { type: 'transcribe', recording_id: 'rec-1', install_id: INSTALL, poll: true },
        delaySeconds: 300,
      },
    ]);
    await runTranscribe(deps(h), 'rec-1', 1);
    await runTranscribe(deps(h), 'rec-1', 1, { poll: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 5 }]);
    expect(h.recaps()).toHaveLength(1);
  });

  it('a delayed check on a job the provider still has queues the next check', async () => {
    const h = harness({
      submit: async () => ({ kind: 'pending', handle: 'aai-1' }),
      fetch: async () => ({ kind: 'pending', handle: 'aai-1' }),
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    await runTranscribe(deps(h), 'rec-1', 1, { poll: true });
    expect(h.sent.filter((s) => s.delaySeconds === 300)).toHaveLength(2);
    expect(rows(`select claim_token from transcripts`)).toEqual([{ claim_token: null }]);
  });

  it('a recap send that fails is sent by the next delivery; a redelivery after success sends none', async () => {
    const h = harness({ submit: async () => ({ kind: 'done', result: RESULT }) });
    const send = h.queue.send;
    let fail = true;
    h.queue.send = async (job, options) => {
      if (fail && job.type === 'recap') throw new Error('queue down');
      return send(job, options);
    };
    await expect(runTranscribe(deps(h), 'rec-1', 1)).rejects.toThrow('queue down');
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(rows(`select recap_enqueued_at from transcripts`)).toEqual([
      { recap_enqueued_at: null },
    ]);
    fail = false;
    await runTranscribe(deps(h), 'rec-1', 2);
    await runTranscribe(deps(h), 'rec-1', 3);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(h.recaps()).toHaveLength(1);
  });

  it('the recap consumer takes one job per transcript', async () => {
    const h = harness({ submit: async () => ({ kind: 'done', result: RESULT }) });
    await runTranscribe(deps(h), 'rec-1', 1);
    const [row] = rows(`select id from transcripts`);
    expect(await takeRecapJob(ctx.db, INSTALL, String(row!.id))).toBe(true);
    expect(await takeRecapJob(ctx.db, INSTALL, String(row!.id))).toBe(false);
  });

  it('fails at once on an error that will not pass, with the code and the fixed reason', async () => {
    const h = harness({
      submit: async () => {
        throw new SttError('stt_too_long', 'too_long');
      },
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_too_long', failure_reason: 'too_long' },
    ]);
    expect(rows(`select status, claim_token from transcripts`)).toEqual([
      { status: 'failed', claim_token: null },
    ]);
  });

  it('never stores or logs a key the provider echoes back', async () => {
    const SENTINEL = 'sk-REVIEW-KEY-SENTINEL-123456';
    const { rememberSecret } = await import('../lib/stt/redact');
    rememberSecret(SENTINEL);
    const { assemblyAi } = await import('../lib/stt/assemblyai');
    const provider = assemblyAi({
      apiKey: SENTINEL,
      webhook: { url: 'https://m.example.com/x', secret: 's' },
      fetch: async () =>
        Response.json({ error: `Invalid key ${SENTINEL}; Bearer ${SENTINEL}` }, { status: 401 }),
    });
    const h = harness({ submit: provider.submit });
    await runTranscribe(deps(h, { provider: async () => provider }), 'rec-1', 1);
    // An unexpected error that carries the key is redacted in the log too.
    const h2 = harness({
      submit: async () => {
        throw new Error(`socket closed, authorization: ${SENTINEL}`);
      },
    });
    seedRecording(ctx.raw, 'rec-2');
    await runTranscribe(deps(h2), 'rec-2', MAX_ATTEMPTS);
    const everything = JSON.stringify([
      rows(`select * from recordings`),
      rows(`select * from transcripts`),
      log.log.mock.calls,
      log.error.mock.calls,
    ]);
    expect(everything).not.toContain(SENTINEL);
    expect(rows(`select failure, failure_reason from recordings order by id`)).toEqual([
      { failure: 'stt_auth', failure_reason: 'unauthorised:401' },
      { failure: 'stt_failed', failure_reason: 'internal' },
    ]);
  });

  it('retries a passing error twice, then fails on the third delivery', async () => {
    const h = harness({
      submit: async () => {
        throw new SttError('stt_failed', 'provider_error', true, 503);
      },
    });
    await expect(runTranscribe(deps(h), 'rec-1', 1)).rejects.toThrow('503');
    await expect(runTranscribe(deps(h), 'rec-1', 2)).rejects.toThrow('503');
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
    await runTranscribe(deps(h), 'rec-1', 3);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_failed', failure_reason: 'provider_error:503' },
    ]);
  });

  it('fails on the third delivery when writing the result keeps failing', async () => {
    const h = harness({ submit: async () => ({ kind: 'done', result: RESULT }) });
    h.storage.put = async () => {
      throw new Error('storage down');
    };
    await expect(runTranscribe(deps(h), 'rec-1', 1)).rejects.toThrow('storage down');
    await expect(runTranscribe(deps(h), 'rec-1', 2)).rejects.toThrow('storage down');
    await runTranscribe(deps(h), 'rec-1', 3);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_failed', failure_reason: 'internal' },
    ]);
  });

  it('waits, without failing, while no provider is chosen', async () => {
    ctx.raw.exec(`UPDATE settings SET stt_provider = NULL`);
    const h = harness({ submit: vi.fn() });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(rows(`select status, failure from recordings`)).toEqual([
      { status: 'transcribing', failure: null },
    ]);
  });

  it('records a provider-side error from the async job as a fixed reason', async () => {
    const h = harness({
      submit: async () => ({ kind: 'pending', handle: 'aai-2' }),
      fetch: async () => ({ kind: 'failed', reason: 'bad_audio' }),
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_failed', failure_reason: 'bad_audio' },
    ]);
  });

  it('a failed row stays failed until Try again resets it, then submits on the same row', async () => {
    let n = 0;
    const h = harness({
      submit: async () => {
        if (n++ === 0) throw new SttError('stt_auth', 'unauthorised', false, 401);
        return { kind: 'done', result: RESULT };
      },
    });
    await runTranscribe(deps(h), 'rec-1', 1);
    // A stray redelivery does not touch the failed row.
    ctx.raw.exec(`UPDATE recordings SET status = 'transcribing'`);
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select status from transcripts`)).toEqual([{ status: 'failed' }]);
    // What retryTranscription does.
    ctx.raw.exec(`UPDATE transcripts SET status = 'pending', provider_job_id = NULL`);
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

  it('writes 41,500 words, 6,000 segments and 14 speakers with no D1 value over 1,900,000 bytes', async () => {
    const words = Array.from({ length: 41_500 }, (_, i) => ({
      text: `ordnummer${i}æøå`,
      start: i * 350,
      end: i * 350 + 300,
      speaker: String.fromCharCode(65 + (i % 14)),
      confidence: 0.9,
    }));
    const utterances = Array.from({ length: 6000 }, (_, u) => {
      const slice = words.slice(
        Math.floor((u * 41_500) / 6000),
        Math.floor(((u + 1) * 41_500) / 6000),
      );
      return {
        speaker: slice[0]!.speaker,
        start: slice[0]!.start,
        end: slice.at(-1)!.end,
        text: slice.map((w) => w.text).join(' '),
        words: slice,
      };
    });
    const big: SttResult = mapAssemblyAi({ ...fixture, words, utterances } as AaiTranscript, 'da');
    expect(JSON.stringify(big.raw).length).toBeGreaterThan(MAX_D1_VALUE_BYTES);
    const h = harness({ submit: async () => ({ kind: 'done', result: big }) });
    await runTranscribe(deps(h), 'rec-1', 1);
    expect(rows(`select count(*) n from segments`)).toEqual([{ n: 6000 }]);
    expect(rows(`select count(*) n from speakers`)).toEqual([{ n: 14 }]);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(ctx.largestValue()).toBeLessThanOrEqual(MAX_D1_VALUE_BYTES);
    expect(h.stored.size).toBe(1);
  });

  it('leaves a recording of another install alone', async () => {
    const h = harness({ submit: vi.fn() });
    await runTranscribe({ ...deps(h), installId: 'other' }, 'rec-1', 1);
    expect(h.provider.submit).not.toHaveBeenCalled();
    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribing' }]);
  });
});

describe('the drain job', () => {
  it('queues 1,001 waiting recordings 100 at a time and stops', async () => {
    const ctx = await testDb();
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES
      ('owner', '${INSTALL}', 'sub', 'owner@example.com', 'Mette Lund');
      INSERT INTO meetings (id, install_id, owner_id, title, started_at, visibility)
      VALUES ('meet-1', '${INSTALL}', 'owner', 'Møde', 0, 'private');`);
    const values = Array.from(
      { length: 1001 },
      (_, i) =>
        `('w${String(i).padStart(4, '0')}', '${INSTALL}', 'meet-1', 'owner', 'upload', 1, '', 1, 'audio/webm', 'p', 'transcribing', 1)`,
    );
    ctx.raw
      .exec(`INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s,
      sha256, size_bytes, content_type, storage_path, status, created_at) VALUES ${values.join(',')};`);
    // One that is already submitted and one done: not waiting.
    seedRecording(ctx.raw, 'zz-submitted');
    seedRecording(ctx.raw, 'zz-done');
    ctx.raw.exec(`INSERT INTO transcripts (id, install_id, recording_id, provider, model, language,
      raw_json, status, provider_job_id) VALUES
      ('t1', '${INSTALL}', 'zz-submitted', 'assemblyai', 'm', '', '{}', 'pending', 'aai'),
      ('t2', '${INSTALL}', 'zz-done', 'assemblyai', 'm', '', '{}', 'done', null)`);

    const queued: Job[] = [];
    const pending: Job[] = [{ type: 'drain_transcriptions', install_id: INSTALL }];
    const queue = {
      send: async (job: Job) => void pending.push(job),
      sendBatch: async (jobs: { body: Job }[]) => void queued.push(...jobs.map((j) => j.body)),
    };
    let steps = 0;
    while (pending.length) {
      const job = pending.shift()!;
      if (job.type !== 'drain_transcriptions') throw new Error('unexpected');
      await drainStep(ctx.db, INSTALL, queue, job.after);
      steps++;
    }
    expect(steps).toBe(11);
    expect(queued).toHaveLength(1001);
    expect(new Set(queued.map((j) => (j.type === 'transcribe' ? j.recording_id : ''))).size).toBe(
      1001,
    );
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
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { db: ctx.db, installId, queue, settingsKey: KEY, sealedSecret: sealed },
    );

  it('refuses a wrong or missing secret with 401 before it reads the body', async () => {
    expect((await call('wrong', { transcript_id: 'aai-1', status: 'completed' })).status).toBe(401);
    expect((await call(null, { transcript_id: 'aai-1', status: 'completed' })).status).toBe(401);
    expect((await call('', { transcript_id: 'aai-1', status: 'completed' })).status).toBe(401);
    expect((await call('wrong', 'not json at all')).status).toBe(401);
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
    expect((await call('the-secret', { transcript_id: 'nope', status: 'error' })).status).toBe(200);
    expect(sent).toEqual([]);
  });

  it('ignores a transcript of another install', async () => {
    expect(
      (await call('the-secret', { transcript_id: 'aai-1', status: 'completed' }, 'other')).status,
    ).toBe(200);
    expect(sent).toEqual([]);
  });

  it('refuses a body that is not the webhook shape with 400', async () => {
    for (const body of [
      {},
      [],
      'null',
      '"aai-1"',
      { transcript_id: 'aai-1' },
      { transcript_id: 'aai-1', status: 'queued' },
      { transcript_id: 7, status: 'completed' },
      { transcript_id: 'x'.repeat(129), status: 'completed' },
      'not json',
    ]) {
      expect((await call('the-secret', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(parseWebhook({ transcript_id: 'x'.repeat(128), status: 'error' })).not.toBeNull();
  });

  it('compares secrets in full', async () => {
    expect(await secretMatches('abc', 'abc')).toBe(true);
    expect(await secretMatches('abd', 'abc')).toBe(false);
    expect(await secretMatches('', '')).toBe(false);
  });
});
