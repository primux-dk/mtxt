import type { JobHandler, JobMessage } from './queue';
import { describeError } from './redact';

/**
 * The background jobs. Messages are plain JSON so a database-backed queue in
 * the Docker edition carries them unchanged.
 */
export interface TranscribeJob {
  type: 'transcribe';
  recording_id: string;
  install_id: string;
  /** A delayed check on an async provider's job, in case its webhook never comes. */
  poll?: boolean;
}

/** `transcript_id` is the idempotency key: the consumer takes one recap job per transcript. */
export interface RecapJob {
  type: 'recap';
  meeting_id: string;
  transcript_id: string;
  install_id: string;
}

/** Queues the recordings that waited for a provider, 100 at a time, after `after` (a recording id). */
export interface DrainTranscriptionsJob {
  type: 'drain_transcriptions';
  install_id: string;
  after?: string;
}

export type Job = TranscribeJob | RecapJob | DrainTranscriptionsJob;
export type JobType = Job['type'];
export const JOB_TYPES = [
  'transcribe',
  'recap',
  'drain_transcriptions',
] as const satisfies readonly JobType[];

export function isJob(value: unknown): value is Job {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Record<string, unknown>;
  if (typeof job.install_id !== 'string') return false;
  if (job.type === 'transcribe') {
    return (
      typeof job.recording_id === 'string' &&
      (job.poll === undefined || typeof job.poll === 'boolean')
    );
  }
  if (job.type === 'recap') {
    return typeof job.meeting_id === 'string' && typeof job.transcript_id === 'string';
  }
  if (job.type === 'drain_transcriptions') {
    return job.after === undefined || typeof job.after === 'string';
  }
  return false;
}

export type JobHandlers<Env> = {
  [K in JobType]?: (
    job: Extract<Job, { type: K }>,
    message: JobMessage<unknown>,
    env: Env,
  ) => Promise<void>;
};

/**
 * One consumer for every job type. Messages arrive untyped and are checked. A handler that throws has its message
 * retried; a message that is not a job is dropped with a log line. A type
 * without a handler is logged and left alone, which the queue counts as
 * delivered.
 */
export function routeJobs<Env>(
  handlers: JobHandlers<Env>,
  log: Pick<Console, 'error'> = console,
): JobHandler<unknown, Env> {
  return async (messages, env) => {
    for (const message of messages) {
      const job: unknown = message.body;
      if (!isJob(job)) {
        log.error('Dropping a message that is not a job', message.id);
        message.ack();
        continue;
      }
      const handler = handlers[job.type] as
        ((job: Job, message: JobMessage<unknown>, env: Env) => Promise<void>) | undefined;
      if (!handler) {
        log.error(`No handler for ${job.type} jobs yet`, message.id);
        continue;
      }
      try {
        await handler(job, message, env);
      } catch (error) {
        // The one place a job's error is logged: reduced, never the raw message or stack.
        log.error(`The ${job.type} job failed; retrying`, message.id, describeError(error));
        message.retry();
      }
    }
  };
}
