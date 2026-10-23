import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeError,
  rememberSecret,
  routeJobs,
  type Job,
  type JobMessage,
  type StorageAdapter,
} from '@mtxt/adapters';
import { assemblyAi } from '../lib/stt/assemblyai';
import { runTranscribe } from '../lib/transcription/job';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

/*
  A provider answers with a malformed body that contains the API key. The
  job's own log, the queue router's log and anything that reaches the
  console carry no trace of it: the router logs a reduced error, never the
  original exception.
*/
const SENTINEL = 'KEY_SENTINEL_5f2c9a1e';

describe('the queue router logs no secret', () => {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  afterEach(() => {
    lines.length = 0;
    vi.restoreAllMocks();
  });

  it('through a real transcribe delivery with a malformed AssemblyAI response', async () => {
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(capture);
    }
    rememberSecret(SENTINEL);
    const ctx = await testDb();
    seedRecording(ctx.raw);
    ctx.raw.exec(`INSERT INTO settings (install_id, product_name, language, stt_provider)
      VALUES ('${INSTALL}', 'M', 'da', 'assemblyai')`);
    const provider = assemblyAi({
      apiKey: SENTINEL,
      webhook: { url: 'https://m.example.com/api/v1/webhooks/assemblyai', secret: 's' },
      // Not JSON, with the key in it, as a broken proxy might answer.
      fetch: async () => new Response(`{"upload_url": ${SENTINEL} <html>`, { status: 200 }),
    });
    const storage = {
      get: async () => ({ key: 'k', size: 3, body: new Response('abc').body! }),
    } as unknown as StorageAdapter;
    const queue = { send: async () => {}, sendBatch: async () => {} };
    const handle = routeJobs(
      {
        async transcribe(job, message) {
          await runTranscribe(
            { db: ctx.db, installId: INSTALL, storage, queue, provider: async () => provider },
            job.recording_id,
            message.attempts,
          );
          message.ack();
        },
      },
      { error: capture },
    );
    const message = (attempts: number) =>
      ({
        id: `m${attempts}`,
        body: { type: 'transcribe', recording_id: 'rec-1', install_id: INSTALL } satisfies Job,
        attempts,
        ack: vi.fn(),
        retry: vi.fn(),
      }) as JobMessage<unknown>;
    const first = message(1);
    await handle([first], {});
    expect(first.retry).toHaveBeenCalled();
    await handle([message(2)], {});
    await handle([message(3)], {});

    const rows = JSON.stringify(ctx.raw.prepare(`select * from recordings`).all());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect(rows).not.toContain(SENTINEL);
    expect(lines.join('\n')).toContain(
      'The transcribe job failed; retrying m1 SttError: provider_error',
    );
    expect(rows).toContain('provider_error:200');
  });

  it('reduces any thrown error to its name, class and status', () => {
    const syntax = new SyntaxError(`Unexpected token K in JSON: ${SENTINEL}`);
    expect(describeError(syntax)).toBe('SyntaxError: unexpected');
    expect(
      describeError({ name: 'SttError', reason: 'unauthorised', status: 401, message: SENTINEL }),
    ).toBe('SttError: unauthorised (HTTP 401)');
    expect(describeError(`plain string ${SENTINEL}`)).toBe('Error: unexpected');
    expect(describeError(null)).toBe('Error: unexpected');
  });

  it('a handler that throws a raw error is logged reduced by the router', async () => {
    vi.spyOn(console, 'error').mockImplementation(capture);
    const handle = routeJobs({
      async transcribe() {
        throw new SyntaxError(`bad body ${SENTINEL}`);
      },
    });
    const m = {
      id: 'x',
      body: { type: 'transcribe', recording_id: 'r', install_id: 'i' },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    } as JobMessage<unknown>;
    await handle([m], {});
    expect(lines).toEqual(['The transcribe job failed; retrying x SyntaxError: unexpected']);
  });
});
