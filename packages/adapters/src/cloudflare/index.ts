import { createDb } from '../db';
import type { Job } from '../jobs';
import { cloudflareQueue } from './queue';
import { r2Storage } from './storage';
import { durableObjectUploadSessions } from './uploads';

export { cloudflareConsumer, cloudflareQueue } from './queue';
export { r2Storage } from './storage';
export { durableObjectUploadSessions } from './uploads';

/** The Cloudflare bindings the adapters read. Names match apps/web/wrangler.jsonc. */
export interface CloudflareBindings {
  DB: D1Database;
  AUDIO: R2Bucket;
  JOBS: Queue<Job>;
  // The class lives in apps/web; any DO class with the UploadSession methods fits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UPLOAD_SESSIONS: DurableObjectNamespace<any>;
  INSTALL_ID: string;
}

/** Every adapter for one request, bound to the Worker's env. */
export function cloudflareAdapters(env: CloudflareBindings) {
  return {
    installId: env.INSTALL_ID,
    db: createDb(env),
    storage: r2Storage(env.AUDIO),
    queue: cloudflareQueue(env.JOBS),
    uploads: durableObjectUploadSessions(env.UPLOAD_SESSIONS),
  };
}
