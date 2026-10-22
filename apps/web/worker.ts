/**
 * The Worker entry. OpenNext builds the Next.js app into .open-next/worker.js;
 * this file adds what Next.js cannot export: the queue consumer and the
 * Durable Object class.
 */
import { cloudflareConsumer } from '@mtxt/adapters/cloudflare';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore .open-next/worker.js exists only after `opennextjs-cloudflare build`.
import { default as nextHandler } from './.open-next/worker.js';
import { handleJobs } from './workers/jobs';

export { UploadSession } from './workers/upload-session';

const queue = cloudflareConsumer<unknown, CloudflareEnv>(handleJobs);

export default {
  fetch: nextHandler.fetch,
  queue,
} satisfies ExportedHandler<CloudflareEnv>;
