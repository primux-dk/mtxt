import type { Job } from '../jobs';
import type { JobHandler, JobMessage, QueueAdapter } from '../queue';

/** Cloudflare Queues behind the queue interface. */
export function cloudflareQueue<T = Job>(queue: Queue<T>): QueueAdapter<T> {
  return {
    async send(job, options) {
      await queue.send(job, options);
    },
    async sendBatch(jobs) {
      await queue.sendBatch(jobs);
    },
  };
}

/** Turns a JobHandler into the `queue()` export a Worker needs. */
export function cloudflareConsumer<T = Job, Env = unknown>(handler: JobHandler<T, Env>) {
  return async (batch: MessageBatch<T>, env: Env): Promise<void> => {
    const messages: JobMessage<T>[] = batch.messages.map((m) => ({
      id: m.id,
      body: m.body,
      attempts: m.attempts,
      ack: () => m.ack(),
      retry: (options) => m.retry(options),
    }));
    await handler(messages, env);
  };
}
