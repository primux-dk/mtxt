/*
  The webhook job (docs/spec.md "Webhooks", Delivery). One message is one
  attempt of one delivery. The attempt is claimed with one conditional
  UPDATE (pending at the previous attempt, or a lapsed `sending` of this
  one), so a duplicate or stale message does nothing. Then the payload is
  built afresh, the address checked, and one POST made with a 10-second
  timeout and no redirect followed; the answer's status is kept, its body
  never read. A failure waits by the backoff schedule and the sixth is
  parked. Nothing the consumer says, and no secret, reaches a log.
*/
import { and, eq, sql } from 'drizzle-orm';
import {
  audit,
  describeError,
  open,
  readSettings,
  rememberSecret,
  schema,
  type Db,
  type HostResolver,
  type QueueAdapter,
  type WebhookJob,
} from '@mtxt/adapters';
import { checkTarget } from './address';
import { available, buildPayload, meetingMeta, signedLinks } from './payload';
import {
  ATTEMPT_LEASE_MS,
  backoffAfter,
  mayBeSent,
  QUEUE_MAX_DELAY_S,
  SEND_TIMEOUT_MS,
} from './rules';
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, signatureHeader } from './signature';
import { sendAttempt, type QueuedPayload } from './store';

export interface WebhookDeps {
  db: Db;
  installId: string;
  queue: QueueAdapter;
  resolver: HostResolver;
  settingsKey: string | undefined;
  /** The install's origin, for the export links (PUBLIC_URL). */
  publicUrl: string | undefined;
  /** The e2e build only: the receiver on http://localhost passes the address check. */
  allowLocal?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: Pick<Console, 'log' | 'error'>;
}

/** Why an attempt failed, as stored in `last_error`: fixed words, never the consumer's. */
export type FailReason =
  'http_status' | 'redirect' | 'timeout' | 'network' | 'private_address' | 'dns' | 'config';

/** Why a delivery was not sent at all. */
export type CancelReason = 'not_eligible' | 'meeting_gone' | 'endpoint_disabled';

const d = schema.webhookDeliveries;

/** The origin for links: PUBLIC_URL as a bare https origin (http://localhost only when allowed). */
export function linkOrigin(publicUrl: string | undefined, allowLocal = false): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    const bare = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    const local =
      url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port;
    if (!bare || !(url.protocol === 'https:' || (local && allowLocal))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function runWebhook(deps: WebhookDeps, job: WebhookJob): Promise<void> {
  const { db, installId } = deps;
  const now = deps.now?.() ?? new Date();
  const row = await db
    .select()
    .from(d)
    .where(and(eq(d.installId, installId), eq(d.id, job.delivery_id)))
    .get();
  if (!row || !['pending', 'sending'].includes(row.status)) return;

  // Not due yet: a wait over the queue's 12-hour limit, or a lease still held. Come back then.
  const due = row.nextAttemptAt.getTime();
  const mine =
    (row.status === 'pending' && row.attempts === job.attempt - 1) ||
    (row.status === 'sending' && row.attempts === job.attempt);
  if (!mine) return; // A stale message: this attempt was made, or Retry now moved on.
  if (due > now.getTime() + 1000) {
    const wait = Math.min(QUEUE_MAX_DELAY_S, Math.ceil((due - now.getTime()) / 1000));
    await sendAttempt(deps.queue, installId, row.id, job.attempt, wait);
    return;
  }

  const claimed = await db
    .update(d)
    .set({
      status: 'sending',
      attempts: job.attempt,
      nextAttemptAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
      lastAttemptAt: now,
    })
    .where(
      and(
        eq(d.installId, installId),
        eq(d.id, row.id),
        sql`((${d.status} = 'pending' and ${d.attempts} = ${job.attempt - 1})
          or (${d.status} = 'sending' and ${d.attempts} = ${job.attempt}))`,
        sql`${d.nextAttemptAt} <= ${now.getTime() + 1000}`,
      ),
    )
    .returning({ id: d.id });
  if (!claimed.length) return;
  try {
    await attempt(deps, job, row, now);
  } catch (error) {
    // Unexpected, such as a database error: the claim goes back, so the queue's redelivery of
    // this message retakes it at once rather than after the lease. If the POST had gone out, the
    // consumer may see the delivery twice; X-Mtxt-Delivery is the same both times.
    await db
      .update(d)
      .set({ status: 'pending', attempts: job.attempt - 1, nextAttemptAt: now })
      .where(
        and(
          eq(d.installId, installId),
          eq(d.id, row.id),
          eq(d.status, 'sending'),
          eq(d.attempts, job.attempt),
        ),
      )
      .catch(() => {});
    throw error;
  }
}

/** One claimed attempt: build, check, post, record. */
async function attempt(
  deps: WebhookDeps,
  job: WebhookJob,
  row: typeof d.$inferSelect,
  now: Date,
): Promise<void> {
  const { db, installId } = deps;
  const log = deps.log ?? console;

  /** Writes the attempt's end, only while this attempt still holds the row. */
  const finish = (values: Partial<typeof d.$inferInsert>) =>
    db
      .update(d)
      .set(values)
      .where(
        and(
          eq(d.installId, installId),
          eq(d.id, row.id),
          eq(d.status, 'sending'),
          eq(d.attempts, job.attempt),
        ),
      );
  const cancel = (reason: CancelReason) =>
    finish({ status: 'cancelled', lastError: reason, lastStatusCode: null });
  const fail = async (reason: FailReason, status: number | null = null) => {
    const wait = backoffAfter(job.attempt);
    if (wait === null) {
      await finish({ status: 'parked', lastError: reason, lastStatusCode: status });
      log.log(`Webhook delivery parked after attempt ${job.attempt}`, row.id, reason);
      return;
    }
    await finish({
      status: 'pending',
      lastError: reason,
      lastStatusCode: status,
      nextAttemptAt: new Date(now.getTime() + wait * 1000),
    });
    await sendAttempt(deps.queue, installId, row.id, job.attempt + 1, wait);
  };

  const endpoint = await db.query.webhookEndpoints.findFirst({
    where: and(
      eq(schema.webhookEndpoints.installId, installId),
      eq(schema.webhookEndpoints.id, row.endpointId),
    ),
  });
  if (!endpoint || !endpoint.enabled) return void (await cancel('endpoint_disabled'));

  const queued = row.payload as unknown as QueuedPayload;
  const settings = await readSettings(db, installId);
  const origin = linkOrigin(deps.publicUrl, deps.allowLocal);
  if (!deps.settingsKey || !origin) return fail('config');

  // The payload, built now: fresh links and the current title, unless the meeting is gone.
  let payload;
  let ownerId: string | null = null;
  if (row.event === 'webhook.test' || row.event === 'meeting.deleted') {
    payload = buildPayload({
      event: queued.event,
      now,
      productName: settings.productName,
      meeting: queued.meeting,
    });
  } else {
    const meeting = row.meetingId
      ? await db.query.meetings.findFirst({
          where: and(
            eq(schema.meetings.id, row.meetingId),
            eq(schema.meetings.installId, installId),
          ),
        })
      : undefined;
    const meta = meeting ? await meetingMeta(db, installId, meeting.id) : null;
    if (!meeting || !meta || meeting.deletedAt) return void (await cancel('meeting_gone'));
    if (!mayBeSent(meeting, settings.webhookAutoSend)) return void (await cancel('not_eligible'));
    ownerId = meta.ownerId;
    const { links, expiresAt } = await signedLinks({
      settingsKey: deps.settingsKey,
      origin,
      meetingId: meeting.id,
      endpointId: endpoint.id,
      now,
      has: await available(db, installId, meeting.id),
    });
    payload = buildPayload({
      event: queued.event,
      now,
      productName: settings.productName,
      meeting: meta,
      links,
      expiresAt,
    });
  }

  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return fail('config');
  }
  const refused = await checkTarget(url, deps.resolver, { allowLocal: deps.allowLocal });
  if (refused) return fail(refused);

  let secret: string;
  try {
    secret = await open(endpoint.secret, 'webhook_endpoints.secret', deps.settingsKey);
    rememberSecret(secret);
  } catch {
    return fail('config');
  }
  const body = JSON.stringify(payload);
  const t = Math.floor(now.getTime() / 1000);
  let status: number;
  try {
    const response = await (deps.fetch ?? fetch)(url.toString(), {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'mtxt-webhooks/1',
        [EVENT_HEADER]: row.event,
        [DELIVERY_HEADER]: row.id,
        [SIGNATURE_HEADER]: await signatureHeader(secret, body, t),
      },
      body,
    });
    status = response.status;
    // The answer's body is never read.
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    const name = (error as { name?: string })?.name;
    log.error('Webhook attempt failed', row.id, describeError(error));
    return fail(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
  }
  if (status >= 300 && status < 400) return fail('redirect', status);
  if (status < 200 || status >= 300) return fail('http_status', status);

  await finish({ status: 'delivered', lastStatusCode: status, lastError: null });
  if (ownerId && row.meetingId) {
    // No service identity: the row names the meeting's owner and, in details, the endpoint.
    await audit(db, installId, {
      userId: ownerId,
      meetingId: row.meetingId,
      meetingTitle: payload.meeting?.title ?? null,
      action: 'webhook_sent',
      details: { endpoint: endpoint.label, event: row.event },
    }).catch((error) => log.error('Could not write the webhook audit row', describeError(error)));
  }
}
