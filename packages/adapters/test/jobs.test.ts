import { describe, expect, it, vi } from 'vitest';
import { isJob, routeJobs, type Job } from '../src/jobs';
import type { JobMessage } from '../src/queue';

const message = (body: unknown, id = 'm1') => {
  const m = { id, body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  return m as typeof m & JobMessage<unknown>;
};

describe('jobs', () => {
  it('recognises the job types', () => {
    expect(isJob({ type: 'transcribe', recording_id: 'r', install_id: 'i' })).toBe(true);
    expect(isJob({ type: 'recap', meeting_id: 'm', transcript_id: 't', install_id: 'i' })).toBe(
      true,
    );
    // The recap job carries its transcript as the idempotency key.
    expect(isJob({ type: 'recap', meeting_id: 'm', install_id: 'i' })).toBe(false);
    expect(isJob({ type: 'drain_transcriptions', install_id: 'i' })).toBe(true);
    expect(isJob({ type: 'drain_transcriptions', install_id: 'i', after: 'r9' })).toBe(true);
    expect(isJob({ type: 'transcribe', recording_id: 'r', install_id: 'i', poll: true })).toBe(
      true,
    );
    expect(isJob({ type: 'retention', install_id: 'i', now: 1 })).toBe(true);
    expect(isJob({ type: 'retention', install_id: 'i', now: 'tonight' })).toBe(false);
    expect(isJob({ type: 'transcribe', install_id: 'i' })).toBe(false);
    expect(isJob({ type: 'export', install_id: 'i' })).toBe(false);
    expect(isJob(null)).toBe(false);
  });

  it('routes by type, retries a failing handler and drops what is not a job', async () => {
    const log = { error: vi.fn() };
    const transcribe = vi.fn(async (job: Job) => {
      if (job.type === 'transcribe' && job.recording_id === 'bad') throw new Error('boom');
    });
    const handle = routeJobs({ transcribe }, log);
    const ok = message({ type: 'transcribe', recording_id: 'r1', install_id: 'dev' });
    const failing = message({ type: 'transcribe', recording_id: 'bad', install_id: 'dev' });
    const recap = message({
      type: 'recap',
      meeting_id: 'm1',
      transcript_id: 't1',
      install_id: 'dev',
    });
    const junk = message('hello');
    await handle([ok, failing, recap, junk], {});

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(failing.retry).toHaveBeenCalledOnce();
    expect(junk.ack).toHaveBeenCalledOnce();
    // No recap handler yet: logged, neither acked nor retried.
    expect(recap.ack).not.toHaveBeenCalled();
    expect(recap.retry).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('No handler for recap jobs yet', 'm1');
  });
});
