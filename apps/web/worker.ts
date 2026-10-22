/**
 * The Worker entry. OpenNext builds the Next.js app into .open-next/worker.js;
 * this file adds what Next.js cannot export: the queue consumer and the
 * Durable Object class.
 */
import { cloudflareConsumer } from '@mtxt/adapters/cloudflare';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore .open-next/worker.js exists only after `opennextjs-cloudflare build`.
import { default as nextHandler } from './.open-next/worker.js';

export { UploadSession } from './workers/upload-session';

const queue = cloudflareConsumer<unknown, CloudflareEnv>(async (messages) => {
  // Transcription and recap jobs arrive in later packets. Nothing sends jobs yet.
  for (const message of messages) {
    console.warn('No handler for job yet; dropping it', message.id);
    message.ack();
  }
});

export default {
  fetch: nextHandler.fetch,
  queue,
} satisfies ExportedHandler<CloudflareEnv>;
