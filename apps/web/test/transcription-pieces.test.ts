import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finishCleanup, type Job, type QueueAdapter, type StorageAdapter } from '@mtxt/adapters';
import { planCut } from '../lib/audio';
import { SttError, type PieceInput, type SttProvider, type SttResult } from '../lib/stt';
import { WHISPER_PIECE_LIMITS } from '../lib/stt/workers-ai';
import { runTranscribe, type TranscribeDeps } from '../lib/transcription/job';
import { PIECE_BUDGET_MS } from '../lib/transcription/pieces';
import { resetForRetry } from '../lib/transcription/store';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

/*
  Packet 17: a recording over the provider's ceiling goes in pieces. The
  limits are scaled down so the 14-second Chromium recording (54 KB) is
  "over the ceiling" and cuts into three pieces; everything else is the
  job as it runs in the Worker.
*/
const AUDIO = new Uint8Array(readFileSync(join(__dirname, 'fixtures/audio/chrome.webm')));
const LIMITS = {
  wholeMaxBytes: 20_000,
  maxBytes: 30_000,
  maxMs: 6_000,
  overlapMs: 500,
  searchMs: 2_000,
};

type Sent = { job: Job; delaySeconds?: number };

function harness(audio: Uint8Array = AUDIO) {
  const sent: Sent[] = [];
  const queue: QueueAdapter = {
    send: async (job, options) => void sent.push({ job, delaySeconds: options?.delaySeconds }),
    sendBatch: async (jobs) => void sent.push(...jobs.map((j) => ({ job: j.body }))),
  };
  const stored = new Map<string, Uint8Array | string>();
  stored.set('recordings/x/rec-1.webm', audio);
  const storage = {
    async get(key: string, range?: { offset: number; length?: number }) {
      const value = stored.get(key);
      if (value === undefined) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      const part = range
        ? bytes.subarray(
            range.offset,
            range.length === undefined ? undefined : range.offset + range.length,
          )
        : bytes;
      return { key, size: bytes.byteLength, body: new Blob([part]).stream() };
    },
    async put(key: string, body: string | Uint8Array) {
      stored.set(key, body);
      return { key, size: body.length };
    },
    async delete(keys: string | string[]) {
      for (const k of [keys].flat()) stored.delete(k);
    },
    async list(prefix: string) {
      return { keys: [...stored.keys()].filter((k) => k.startsWith(prefix)) };
    },
  } as unknown as StorageAdapter;
  return { sent, queue, storage, stored };
}

/** A Whisper stand-in: a word every 400 ms of the piece, named by the piece's own time. */
function whisper(behaviour: (call: number, input: PieceInput) => void = () => {}) {
  const calls: { bytes: number; ms: number }[] = [];
  const transcribePiece = vi.fn(async (input: PieceInput): Promise<SttResult> => {
    const { durationMs } = await planCut(
      async (r) =>
        new Blob([
          r
            ? input.audio.subarray(r.offset, r.length ? r.offset + r.length : undefined)
            : input.audio,
        ]).stream(),
      input.audio.byteLength,
      { maxBytes: 1e9, maxMs: 1e9, overlapMs: 0, searchMs: 0 },
    );
    behaviour(calls.length, input);
    calls.push({ bytes: input.audio.byteLength, ms: durationMs });
    const words = [];
    for (let t = 0; t + 300 <= durationMs; t += 400) {
      words.push({ startMs: t, endMs: t + 300, text: `c${calls.length}t${t}`, speaker: 0 });
    }
    return {
      language: 'da',
      model: '@cf/openai/whisper-large-v3-turbo',
      segments: words.length
        ? [
            {
              startMs: 0,
              endMs: words.at(-1)!.endMs,
              text: words.map((w) => w.text).join(' '),
              speaker: 0,
            },
          ]
        : [],
      speakers: [{ index: 0, label: null }],
      words,
      raw: { call: calls.length },
    };
  });
  const provider: SttProvider = {
    describe: () => ({
      id: 'workers-ai-whisper',
      model: '@cf/openai/whisper-large-v3-turbo',
      supports: { diarization: false, keyterms: true, languages: 'auto' },
    }),
    submit: async () => {
      throw new Error('a recording over the ceiling never goes whole');
    },
    pieces: { limits: LIMITS, transcribePiece },
  };
  return { provider, calls, transcribePiece };
}

describe('a recording in pieces', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  const log = { log: vi.fn(), error: vi.fn() };
  beforeEach(async () => {
    ctx = await testDb();
    seedRecording(ctx.raw);
    ctx.raw.exec(`UPDATE recordings SET size_bytes = ${AUDIO.byteLength};
      INSERT INTO settings (install_id, product_name, language, stt_provider)
      VALUES ('${INSTALL}', 'M', 'da', 'workers-ai-whisper');`);
  });
  afterEach(() => vi.restoreAllMocks());
  const deps = (h: ReturnType<typeof harness>, provider: SttProvider): TranscribeDeps => ({
    db: ctx.db,
    installId: INSTALL,
    storage: h.storage,
    queue: h.queue,
    provider: async () => provider,
    log,
  });
  const rows = (sql: string) => ctx.raw.prepare(sql).all() as Record<string, unknown>[];
  const row = () =>
    rows(`select status, raw_path, chunks_total, chunks_done, claim_token from transcripts`)[0]!;

  it('plans, sends each piece once and in order, keeps one raw object per piece and writes one transcript', async () => {
    const h = harness();
    const w = whisper();
    expect(await runTranscribe(deps(h, w.provider), 'rec-1', 1)).toBeUndefined();
    const t = row();
    expect(t).toMatchObject({ status: 'done', chunks_total: 3, chunks_done: 3, claim_token: null });
    expect(String(t.raw_path)).toMatch(
      /^transcripts\/test-install\/rec-1\/workers-ai-whisper-[0-9a-f-]{36}\/$/,
    );
    const keys = [...h.stored.keys()].filter((k) => k.startsWith(String(t.raw_path))).sort();
    expect(keys.map((k) => k.slice(String(t.raw_path).length))).toEqual([
      'piece-000.json',
      'piece-001.json',
      'piece-002.json',
      'plan.json',
    ]);
    // Each piece under the piece limit, and together the whole recording once plus the overlaps.
    expect(w.calls).toHaveLength(3);
    for (const call of w.calls) {
      expect(call.bytes).toBeLessThanOrEqual(LIMITS.maxBytes);
      expect(call.ms).toBeLessThanOrEqual(LIMITS.maxMs);
    }
    const total = w.calls.reduce((n, c) => n + c.ms, 0);
    expect(total).toBeGreaterThan(14_000);
    expect(total).toBeLessThan(14_000 + 2 * 2 * LIMITS.overlapMs + 200);
    const piece = JSON.parse(String(h.stored.get(keys[1]!)));
    expect(piece).toMatchObject({ index: 1, raw: { call: 2 }, result: { language: 'da' } });

    expect(rows(`select status from recordings`)).toEqual([{ status: 'transcribed' }]);
    expect(rows(`select label, speaker_index from speakers`)).toEqual([
      { label: 'Speaker 1', speaker_index: 0 },
    ]);
    // The stitched words: in time order across 14 seconds. The stand-in names words by each
    // piece's own clock, so the two sides of a seam share none, and the seam's time decides.
    const segments = rows(`select start_ms, end_ms, text from segments order by start_ms`);
    const words = segments.flatMap((s) => String(s.text).split(' '));
    expect(new Set(words).size).toBe(words.length);
    for (let k = 1; k < segments.length; k++) {
      expect(Number(segments[k]!.start_ms)).toBeGreaterThan(Number(segments[k - 1]!.start_ms));
      expect(Number(segments[k]!.start_ms)).toBeGreaterThan(Number(segments[k - 1]!.end_ms) - 300);
    }
    expect(Number(segments.at(-1)!.end_ms)).toBeGreaterThan(13_000);
    expect(words.length).toBeGreaterThan(30);
    expect(h.sent.filter((s) => s.job.type === 'recap')).toHaveLength(1);
  });

  it('a piece that fails is retried alone: the next delivery starts at that piece', async () => {
    const h = harness();
    let failed = false;
    const seen: number[] = [];
    const w = whisper((call) => {
      seen.push(call);
      if (call === 1 && !failed) {
        failed = true;
        throw new SttError('stt_failed', 'provider_error', true, 503, 'Workers AI');
      }
    });
    await expect(runTranscribe(deps(h, w.provider), 'rec-1', 1)).rejects.toThrow(SttError);
    expect(row()).toMatchObject({
      status: 'pending',
      chunks_total: 3,
      chunks_done: 1,
      claim_token: null,
    });
    await runTranscribe(deps(h, w.provider), 'rec-1', 2);
    expect(row()).toMatchObject({ status: 'done', chunks_done: 3 });
    // Pieces 1, 2 (failed), 2 again, 3: piece 1 was not sent twice.
    expect(w.transcribePiece).toHaveBeenCalledTimes(4);
    expect(w.calls).toHaveLength(3);
  });

  it('a delivery past its time budget lets go and queues the rest; each later one carries on', async () => {
    const h = harness();
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const w = whisper(() => {
      clock += PIECE_BUDGET_MS + 1;
    });
    await runTranscribe(deps(h, w.provider), 'rec-1', 1);
    expect(row()).toMatchObject({ status: 'pending', chunks_done: 1, claim_token: null });
    expect(h.sent).toEqual([
      {
        job: { type: 'transcribe', recording_id: 'rec-1', install_id: INSTALL },
        delaySeconds: undefined,
      },
    ]);
    // The meeting page reads the progress from the row.
    await runTranscribe(deps(h, w.provider), 'rec-1', 1);
    expect(row()).toMatchObject({ chunks_done: 2 });
    await runTranscribe(deps(h, w.provider), 'rec-1', 1);
    expect(row()).toMatchObject({ status: 'done', chunks_done: 3 });
    expect(w.calls).toHaveLength(3);
  });

  it('a recording over the ceiling that cannot be cut fails with a fixed reason and a next step', async () => {
    const flac = new TextEncoder().encode('fLaC'.padEnd(30_000, '\0'));
    const h = harness(flac);
    ctx.raw.exec(`UPDATE recordings SET size_bytes = ${flac.byteLength}`);
    const w = whisper();
    await runTranscribe(deps(h, w.provider), 'rec-1', 1);
    expect(rows(`select status, failure, failure_reason from recordings`)).toEqual([
      { status: 'failed', failure: 'stt_too_long', failure_reason: 'unsplittable' },
    ]);
    expect(w.calls).toHaveLength(0);
  });

  it('a recording under the ceiling still goes whole', async () => {
    const h = harness();
    ctx.raw.exec(`UPDATE recordings SET size_bytes = 10000`);
    const w = whisper();
    const submit = vi.fn(async () => ({
      kind: 'done' as const,
      result: await w.transcribePiece({
        audio: AUDIO,
        contentType: 'audio/webm',
        language: 'da',
        keyterms: [],
      }),
    }));
    await runTranscribe(deps(h, { ...w.provider, submit }), 'rec-1', 1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: 'done', chunks_total: null, chunks_done: null });
    expect(String(row().raw_path)).toMatch(/\.json$/);
  });

  it('Try again sends the failed attempt’s pieces to cleanup and plans under a new prefix', async () => {
    const h = harness();
    const w = whisper((call) => {
      if (call === 1) throw new SttError('stt_failed', 'bad_audio', false, 400, 'Workers AI');
    });
    await runTranscribe(deps(h, w.provider), 'rec-1', 1);
    const first = String(row().raw_path);
    expect(rows(`select status from recordings`)).toEqual([{ status: 'failed' }]);
    expect(row()).toMatchObject({ status: 'failed', chunks_done: 1 });

    expect(await resetForRetry(ctx.db, INSTALL, 'meet-1', 'rec-1')).toBe(true);
    expect(row()).toMatchObject({
      status: 'pending',
      raw_path: null,
      chunks_total: null,
      chunks_done: null,
    });
    const cleanup = rows(`select id, path from storage_cleanup`) as { id: string; path: string }[];
    expect(cleanup.map((c) => c.path)).toEqual([first]);
    await finishCleanup(ctx.db, h.storage, INSTALL, cleanup);
    expect([...h.stored.keys()].filter((k) => k.startsWith(first))).toEqual([]);

    await runTranscribe(deps(h, whisper().provider), 'rec-1', 1);
    expect(row()).toMatchObject({ status: 'done', chunks_done: 3 });
    expect(row().raw_path).not.toBe(first);
  });

  it('the Workers AI limits leave room in a Worker: pieces under 12 MiB, files up to 25 MiB whole', () => {
    expect(WHISPER_PIECE_LIMITS.wholeMaxBytes).toBe(25 * 1024 * 1024);
    expect(WHISPER_PIECE_LIMITS.maxBytes).toBe(12 * 1024 * 1024);
    // A piece, its base64 copy and a request body of the same size stay under 128 MB.
    expect(WHISPER_PIECE_LIMITS.maxBytes * (1 + 4 / 3 + 4 / 3)).toBeLessThan(64 * 1024 * 1024);
  });
});
