/**
 * The Worker entry. OpenNext builds the Next.js app into .open-next/worker.js;
 * this file adds what Next.js cannot export: the queue consumer and the
 * Durable Object class.
 */
import { cloudflareConsumer } from '@mtxt/adapters/cloudflare';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore .open-next/worker.js exists only after `opennextjs-cloudflare build`.
import { default as nextHandler } from './.open-next/worker.js';
import { chunkTooLarge, limitChunkBody, type Guarded } from './lib/chunk-guard';
import { keepEmptyRange } from './lib/http-range';
import { handleJobs } from './workers/jobs';

export { UploadSession } from './workers/upload-session';

const queue = cloudflareConsumer<unknown, CloudflareEnv>(handleJobs);

/** A chunk body that ran past 8 MiB answers 413, whatever OpenNext made of the cut-off body. */
function refused(guarded: Guarded): Response | null {
  const taken = guarded.overrun();
  if (taken === null) return null;
  console.log(`chunk body refused at the Worker entry after ${taken} bytes`);
  return chunkTooLarge();
}

export default {
  async fetch(request, env, ctx) {
    const guarded = limitChunkBody(request);
    if (guarded instanceof Response) return guarded;
    try {
      const response = await nextHandler.fetch(keepEmptyRange(guarded.request), env, ctx);
      return refused(guarded) ?? response;
    } catch (error) {
      const tooLarge = refused(guarded);
      if (tooLarge) return tooLarge;
      throw error;
    }
  },
  queue,
} satisfies ExportedHandler<CloudflareEnv>;
