import { DurableObject } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import {
  cloudflareAdapters,
  schema,
  type UploadSession as UploadSessionApi,
  type UploadSessionInit,
} from '@mtxt/adapters';
import { UploadSessionCore, type SessionState } from '../lib/uploads/session';

const KEY = 'session';
/** How long a finished or expired session is kept before it is forgotten. */
const KEEP_FINISHED_MS = 30 * 24 * 3600_000;

/**
 * One resumable upload session per recording (docs/spec.md "How a recording
 * reaches the library"), created with `jurisdiction('eu')` so its state stays
 * in the EU. The bookkeeping is UploadSessionCore; this class gives it
 * Durable Object storage, R2 through the storage adapter, and an alarm that
 * aborts an upload still open after 7 days.
 */
export class UploadSession extends DurableObject<CloudflareEnv> implements UploadSessionApi {
  private readonly core: UploadSessionCore;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    const { storage } = cloudflareAdapters(env);
    this.core = new UploadSessionCore(storage, {
      load: () => ctx.storage.get<SessionState>(KEY),
      save: (state) => ctx.storage.put(KEY, state),
      clear: async () => {
        await ctx.storage.deleteAlarm();
        await ctx.storage.deleteAll();
      },
    });
  }

  async begin(init: UploadSessionInit) {
    await this.core.begin(init);
    const at = this.core.expiresAt();
    if (at && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }

  async putChunk(n: number, body: ReadableStream<Uint8Array> | ArrayBuffer | null) {
    const result = await this.core.putChunk(n, body);
    if (!result.ok && result.code === 'too_large') {
      // The measured read bound (review item 5), in the Worker log.
      console.log(
        `upload session: refused chunk ${n} after ${this.core.lastReadBytes} bytes (byob ${this.core.lastReadByob})`,
      );
    }
    return result;
  }

  async complete(final?: { sha256: string; sizeBytes: number }) {
    const result = await this.core.complete(final);
    // The measured bound on chunk memory (review item 13), in the Worker log.
    const { peakBufferedBytes } = await this.core.status();
    console.log(`upload session: peak buffered bytes ${peakBufferedBytes}`);
    return result;
  }

  status() {
    return this.core.status();
  }

  abort() {
    return this.core.abort();
  }

  override async alarm() {
    const state = await this.ctx.storage.get<SessionState>(KEY);
    const expired = await this.core.expire();
    if (expired && state) {
      // The recording row says so too, unless something else moved it on.
      const { db } = cloudflareAdapters(this.env);
      await db
        .update(schema.recordings)
        .set({ status: 'failed', failure: 'session_expired' })
        .where(
          and(
            eq(schema.recordings.id, state.recordingId),
            eq(schema.recordings.installId, state.installId),
            eq(schema.recordings.status, 'uploading'),
          ),
        );
      await this.ctx.storage.setAlarm(Date.now() + KEEP_FINISHED_MS);
    }
  }
}
