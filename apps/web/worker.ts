/**
 * The Worker entry. OpenNext builds the Next.js app into .open-next/worker.js;
 * this file adds what Next.js cannot export: the queue consumer and the
 * Durable Object class.
 */
import { cloudflareConsumer } from '@mtxt/adapters/cloudflare';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore .open-next/worker.js exists only after `opennextjs-cloudflare build`.
import { default as nextHandler } from './.open-next/worker.js';
import {
  chunkTooLarge,
  limitChunkBody,
  limitWebhookBody,
  webhookTooLarge,
  type Guarded,
} from './lib/chunk-guard';
import { keepEmptyRange } from './lib/http-range';
import { handleJobs } from './workers/jobs';

export { UploadSession } from './workers/upload-session';

const queue = cloudflareConsumer<unknown, CloudflareEnv>(handleJobs);

/** A body that ran past its bound answers 413, whatever OpenNext made of the cut-off body. */
function refused(guarded: Guarded, tooLarge: () => Response): Response | null {
  const taken = guarded.overrun();
  if (taken === null) return null;
  console.log(`body refused at the Worker entry after ${taken} bytes`);
  return tooLarge();
}

export default {
  async fetch(request, env, ctx) {
    const chunk = limitChunkBody(request);
    if (chunk instanceof Response) return chunk;
    const guarded = limitWebhookBody(chunk.request);
    if (guarded instanceof Response) return guarded;
    const check = () => refused(chunk, chunkTooLarge) ?? refused(guarded, webhookTooLarge);
    try {
      const response = await nextHandler.fetch(keepEmptyRange(guarded.request), env, ctx);
      return check() ?? response;
    } catch (error) {
      const tooLarge = check();
      if (tooLarge) return tooLarge;
      throw error;
    }
  },
  queue,
} satisfies ExportedHandler<CloudflareEnv>;
