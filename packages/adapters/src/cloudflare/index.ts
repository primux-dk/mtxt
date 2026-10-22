import { createDb } from '../db';
import type { Job } from '../queue';
import { cloudflareQueue } from './queue';
import { r2Storage } from './storage';

export { cloudflareConsumer, cloudflareQueue } from './queue';
export { r2Storage } from './storage';

/** The Cloudflare bindings the adapters read. Names match apps/web/wrangler.jsonc. */
export interface CloudflareBindings {
  DB: D1Database;
  AUDIO: R2Bucket;
  JOBS: Queue<Job>;
  INSTALL_ID: string;
}

/** Every adapter for one request, bound to the Worker's env. */
export function cloudflareAdapters(env: CloudflareBindings) {
  return {
    installId: env.INSTALL_ID,
    db: createDb(env),
    storage: r2Storage(env.AUDIO),
    queue: cloudflareQueue(env.JOBS),
  };
}
