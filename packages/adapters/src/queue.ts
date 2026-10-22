/**
 * Background jobs: transcription and recap (the message types are in jobs.ts).
 * Cloudflare binds Queues; a Docker edition binds a database-backed queue
 * behind the same interface.
 */
import type { Job } from './jobs';

export interface SendOptions {
  delaySeconds?: number;
}

export interface QueueAdapter<T = Job> {
  send(job: T, options?: SendOptions): Promise<void>;
  sendBatch(jobs: { body: T; delaySeconds?: number }[]): Promise<void>;
}

/** One delivered job. Call ack() when done or retry() to have it delivered again. */
export interface JobMessage<T = Job> {
  id: string;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** The consumer side, the same shape for every queue backend. */
export type JobHandler<T = Job, Env = unknown> = (
  messages: readonly JobMessage<T>[],
  env: Env,
) => Promise<void>;
