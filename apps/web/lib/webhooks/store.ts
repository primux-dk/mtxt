/*
  Webhook endpoints and deliveries in the database (docs/spec.md
  "Webhooks"). Every statement carries the install id. Queueing an event
  writes one delivery per endpoint that takes it and may receive the
  meeting, then sends one `webhook` queue message per new delivery; the job
  (lib/webhooks/deliver.ts) does the sending. Imported by the queue consumer
  and by server actions alike, so nothing here needs Next.js.
*/
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  describeError,
  readSettings,
  schema,
  WEBHOOK_TEST_EVENT,
  type Db,
  type QueueAdapter,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from '@mtxt/adapters';
import { meetingMeta, type DeletedNotice, type MeetingMeta } from './payload';
import { LOG_SIZE, MAX_ENDPOINTS, mayBeSent, QUEUE_MAX_DELAY_S, takes } from './rules';

const e = schema.webhookEndpoints;
const d = schema.webhookDeliveries;

export interface QueueDeps {
  db: Db;
  installId: string;
  queue: QueueAdapter;
  log?: Pick<Console, 'log' | 'error'>;
}

/**
 * What a delivery keeps from when it was queued: the event and the meeting
 * as it was, for the delivery log. For `meeting.deleted`, the notice that
 * goes out (the id and the time only), and the owner and title for the
 * audit row and the log, which never go out.
 */
export interface QueuedPayload {
  event: WebhookEvent | typeof WEBHOOK_TEST_EVENT;
  meeting: MeetingMeta | null;
  deleted?: DeletedNotice;
  owner_id?: string | null;
  title?: string | null;
}

/** The meeting's metadata as a payload carries it: the owner by name and address, not by id. */
const snapshotOf = (meta: MeetingMeta): MeetingMeta => ({
  id: meta.id,
  title: meta.title,
  started_at: meta.started_at,
  duration_s: meta.duration_s,
  visibility: meta.visibility,
  owner: { name: meta.owner.name, email: meta.owner.email },
});

export async function listEndpoints(db: Db, installId: string): Promise<WebhookEndpoint[]> {
  return db.select().from(e).where(eq(e.installId, installId)).orderBy(e.createdAt, e.id);
}

export async function findEndpoint(db: Db, installId: string, id: string) {
  return db
    .select()
    .from(e)
    .where(and(eq(e.installId, installId), eq(e.id, id)))
    .get();
}

/**
 * Adds an endpoint while the install has fewer than five: the count is a
 * condition of the insert, so two adds at once cannot make six.
 */
export async function createEndpoint(
  db: Db,
  installId: string,
  input: { label: string | null; url: string; events: WebhookEvent[]; sealedSecret: string },
): Promise<{ ok: true; id: string } | { ok: false; reason: 'too_many' }> {
  const id = crypto.randomUUID();
  const rows = await db.all<{ id: string }>(sql`
    insert into webhook_endpoints (id, install_id, label, url, secret, events, enabled, created_at)
    select ${id}, ${installId}, ${input.label}, ${input.url}, ${input.sealedSecret},
      ${JSON.stringify(input.events)}, 1, ${Date.now()}
    where (select count(*) from webhook_endpoints where install_id = ${installId}) < ${MAX_ENDPOINTS}
    returning id`);
  return rows.length ? { ok: true, id } : { ok: false, reason: 'too_many' };
}

/** Sets the value, so a retry changes nothing twice. */
export async function setEndpointEnabled(db: Db, installId: string, id: string, enabled: boolean) {
  const rows = await db
    .update(e)
    .set({ enabled })
    .where(and(eq(e.installId, installId), eq(e.id, id)))
    .returning({ id: e.id });
  return rows.length > 0;
}

/** The endpoint and its delivery log, in one batch. */
export async function deleteEndpoint(db: Db, installId: string, id: string) {
  await db.batch([
    db.delete(d).where(and(eq(d.installId, installId), eq(d.endpointId, id))),
    db.delete(e).where(and(eq(e.installId, installId), eq(e.id, id))),
  ]);
}

/** The newest delivery of each endpoint, for the list's "last delivery". */
export async function lastDeliveries(db: Db, installId: string) {
  const rows = await db.all<{
    endpoint_id: string;
    status: WebhookDelivery['status'];
    attempts: number;
    last_status_code: number | null;
    last_error: string | null;
    last_attempt_at: number | null;
    created_at: number;
  }>(sql`
    select endpoint_id, status, attempts, last_status_code, last_error, last_attempt_at, created_at
    from (
      select *, row_number() over (partition by endpoint_id order by created_at desc, id desc) as n
      from webhook_deliveries where install_id = ${installId}
    ) where n = 1`);
  return new Map(rows.map((row) => [row.endpoint_id, row]));
}

/** An endpoint's delivery log: the newest LOG_SIZE. */
export async function listDeliveries(db: Db, installId: string, endpointId: string) {
  return db
    .select()
    .from(d)
    .where(and(eq(d.installId, installId), eq(d.endpointId, endpointId)))
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(LOG_SIZE);
}

/** Sends the message for one attempt. A wait past the queue's limit is reached in hops (deliver.ts). */
export async function sendAttempt(
  queue: QueueAdapter,
  installId: string,
  deliveryId: string,
  attempt: number,
  delayS = 0,
) {
  const delay = Math.min(QUEUE_MAX_DELAY_S, Math.max(0, Math.ceil(delayS)));
  await queue.send(
    { type: 'webhook', install_id: installId, delivery_id: deliveryId, attempt },
    delay ? { delaySeconds: delay } : undefined,
  );
}

/**
 * One delivery, unless the endpoint already has an unsent one of the same
 * event for the same meeting (it joins that one: the payload is built when
 * it is sent) or one with the same dedupe key. Answers the new id or null.
 */
async function insertDelivery(
  db: Db,
  installId: string,
  input: {
    endpointId: string;
    payload: QueuedPayload;
    meetingId: string | null;
    dedupeKey: string | null;
    at: Date;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const event = input.payload.event;
  const rows = await db.all<{ id: string }>(sql`
    insert into webhook_deliveries (id, install_id, endpoint_id, event, meeting_id, payload,
      attempts, next_attempt_at, status, dedupe_key, created_at)
    select ${id}, ${installId}, ${input.endpointId}, ${event}, ${input.meetingId},
      ${JSON.stringify(input.payload)}, 0, ${input.at.getTime()}, 'pending', ${input.dedupeKey},
      ${Date.now()}
    where exists (select 1 from webhook_endpoints where id = ${input.endpointId}
        and install_id = ${installId})
      and not exists (select 1 from webhook_deliveries where install_id = ${installId}
        and endpoint_id = ${input.endpointId} and event = ${event} and meeting_id is ${input.meetingId}
        and status = 'pending' and attempts = 0)
    on conflict do nothing
    returning id`);
  return rows[0]?.id ?? null;
}

/**
 * Moves an unsent `recap.saved` delivery to `at`, in one UPDATE, and gives
 * it the latest version's dedupe key unless another delivery holds that key.
 * Its queued message comes early, finds it not due, and sends itself on
 * (deliver.ts); the payload is built when it goes, from the latest version.
 */
async function postponeSaved(
  db: Db,
  installId: string,
  input: { endpointId: string; meetingId: string; dedupeKey: string | null; at: Date },
): Promise<boolean> {
  const rows = await db.all<{ id: string }>(sql`
    update webhook_deliveries
    set next_attempt_at = ${input.at.getTime()},
      dedupe_key = case
        when ${input.dedupeKey} is null or exists (select 1 from webhook_deliveries x
          where x.install_id = ${installId} and x.endpoint_id = ${input.endpointId}
            and x.dedupe_key = ${input.dedupeKey})
        then dedupe_key else ${input.dedupeKey} end
    where install_id = ${installId} and endpoint_id = ${input.endpointId}
      and event = 'recap.saved' and meeting_id = ${input.meetingId}
      and status = 'pending' and attempts = 0
    returning id`);
  return rows.length > 0;
}

/** Writes the deliveries and sends their messages. A message the queue refused is sent by the nightly sweep. */
async function queueFor(
  deps: QueueDeps,
  endpoints: { id: string }[],
  input: { payload: QueuedPayload; meetingId: string | null; dedupeKey?: string; delayS?: number },
): Promise<number> {
  const at = new Date(Date.now() + (input.delayS ?? 0) * 1000);
  let queued = 0;
  for (const endpoint of endpoints) {
    // `recap.saved` is debounced: a save moves the unsent delivery to a minute after itself.
    if (input.payload.event === 'recap.saved' && input.meetingId) {
      const moved = await postponeSaved(deps.db, deps.installId, {
        endpointId: endpoint.id,
        meetingId: input.meetingId,
        dedupeKey: input.dedupeKey ?? null,
        at,
      });
      if (moved) continue;
    }
    const id = await insertDelivery(deps.db, deps.installId, {
      endpointId: endpoint.id,
      payload: input.payload,
      meetingId: input.meetingId,
      dedupeKey: input.dedupeKey ?? null,
      at,
    });
    if (!id) continue;
    queued++;
    await sendAttempt(deps.queue, deps.installId, id, 1, input.delayS).catch((error) =>
      (deps.log ?? console).error('Could not queue a webhook delivery yet', describeError(error)),
    );
  }
  return queued;
}

/**
 * An event for a meeting: a delivery to every enabled endpoint that takes
 * it, when the meeting may be sent now (consent, or "Send automatically").
 * Answers how many deliveries were queued.
 */
export async function queueMeetingEvent(
  deps: QueueDeps,
  input: { event: WebhookEvent; meetingId: string; dedupeKey?: string; delayS?: number },
): Promise<number> {
  const { db, installId } = deps;
  const endpoints = (await listEndpoints(db, installId)).filter(
    (endpoint) => endpoint.enabled && takes(endpoint, input.event),
  );
  if (!endpoints.length) return 0;
  const meeting = await db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, input.meetingId), eq(schema.meetings.installId, installId)),
  });
  const settings = await readSettings(db, installId);
  if (!meeting || !mayBeSent(meeting, settings.webhookAutoSend)) return 0;
  const meta = await meetingMeta(db, installId, meeting.id);
  if (!meta) return 0;
  return queueFor(deps, endpoints, {
    payload: { event: input.event, meeting: snapshotOf(meta) },
    meetingId: meeting.id,
    dedupeKey: input.dedupeKey,
    delayS: input.delayS,
  });
}

/** Waits between tries to queue an event: a transient database error should not lose it. */
export const QUEUE_RETRY_MS = [200, 800] as const;

/**
 * The same, never throwing: an event that cannot be queued must not fail
 * what caused it. A failure is tried again twice, shortly (a locked or busy
 * database), then logged; queueing is idempotent, so a try that half
 * landed is harmless.
 */
export async function queueMeetingEventQuietly(
  deps: QueueDeps,
  input: Parameters<typeof queueMeetingEvent>[1],
  waits: readonly number[] = QUEUE_RETRY_MS,
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await queueMeetingEvent(deps, input);
    } catch (error) {
      if (attempt < waits.length) {
        await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
        continue;
      }
      (deps.log ?? console).error(
        `Could not queue the ${input.event} webhook`,
        input.meetingId,
        describeError(error),
      );
      return 0;
    }
  }
}

/**
 * The current state of a meeting, for the owner's "Send to connected
 * systems": `meeting.transcribed` when a transcript is done, and the recap
 * event of the current version's author. Dedupe keys stop a second press,
 * or an automatic send of the same transcript or version, from sending it
 * twice.
 */
export async function queueCurrentState(deps: QueueDeps, meetingId: string) {
  const { db, installId } = deps;
  const transcript = await db.get<{ id: string } | undefined>(sql`
    select t.id from transcripts t join recordings r on r.id = t.recording_id and r.install_id = ${installId}
    where t.install_id = ${installId} and r.meeting_id = ${meetingId} and t.status = 'done'
      and t.is_comparison = 0
    order by r.is_primary desc, t.created_at desc limit 1`);
  const version = await db.get<{ id: string; author_id: string | null } | undefined>(sql`
    select v.id, v.author_id from recaps c join recap_versions v on v.id = c.current_version_id
      and v.install_id = ${installId}
    where c.install_id = ${installId} and c.meeting_id = ${meetingId}`);
  let queued = 0;
  if (transcript) {
    queued += await queueMeetingEvent(deps, {
      event: 'meeting.transcribed',
      meetingId,
      dedupeKey: `transcribed:${transcript.id}`,
    });
  }
  if (version) {
    const drafted = version.author_id === null;
    queued += await queueMeetingEvent(deps, {
      event: drafted ? 'recap.drafted' : 'recap.saved',
      meetingId,
      dedupeKey: `${drafted ? 'drafted' : 'saved'}:${version.id}`,
    });
  }
  return { queued, transcript: Boolean(transcript), recap: Boolean(version) };
}

/** What a delete must send, worked out before the meeting's rows go. */
export interface DeletedPlan {
  meetingId: string;
  ownerId: string;
  title: string;
  endpointIds: string[];
}

/**
 * Before a delete: the endpoints that take `meeting.deleted`, took an
 * earlier event of this meeting, and may still receive it now (consent, or
 * "Send automatically"). A meeting made private, which took the consent
 * back, tells nobody. Null when there is nobody to tell.
 */
export async function planDeleted(
  db: Db,
  installId: string,
  meetingId: string,
): Promise<DeletedPlan | null> {
  const endpoints = (await listEndpoints(db, installId)).filter(
    (endpoint) => endpoint.enabled && takes(endpoint, 'meeting.deleted'),
  );
  if (!endpoints.length) return null;
  const meeting = await db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, meetingId), eq(schema.meetings.installId, installId)),
  });
  if (!meeting) return null;
  const settings = await readSettings(db, installId);
  if (!mayBeSent({ ...meeting, deletedAt: null }, settings.webhookAutoSend)) return null;
  // Deliveries go out only while the meeting may be sent (deliver.ts), so a delivered one was sent then.
  const delivered = new Set(
    (
      await db
        .selectDistinct({ endpointId: d.endpointId })
        .from(d)
        .where(
          and(eq(d.installId, installId), eq(d.meetingId, meetingId), eq(d.status, 'delivered')),
        )
    ).map((row) => row.endpointId),
  );
  const endpointIds = endpoints.filter((e) => delivered.has(e.id)).map((e) => e.id);
  if (!endpointIds.length) return null;
  return { meetingId, ownerId: meeting.ownerId, title: meeting.title, endpointIds };
}

/** After the delete committed: `meeting.deleted`, once per endpoint, with the id and the time only. */
export async function queueDeleted(deps: QueueDeps, plan: DeletedPlan, deletedAt = new Date()) {
  try {
    return await queueFor(
      deps,
      plan.endpointIds.map((id) => ({ id })),
      {
        payload: {
          event: 'meeting.deleted',
          meeting: null,
          deleted: { id: plan.meetingId, deleted_at: deletedAt.toISOString() },
          owner_id: plan.ownerId,
          title: plan.title,
        },
        meetingId: plan.meetingId,
        dedupeKey: `deleted:${plan.meetingId}`,
      },
    );
  } catch (error) {
    (deps.log ?? console).error('Could not queue meeting.deleted', describeError(error));
    return 0;
  }
}

/** "Send test event": one `webhook.test` delivery to this endpoint, whatever its events. */
export async function queueTestEvent(deps: QueueDeps, endpointId: string) {
  const endpoint = await findEndpoint(deps.db, deps.installId, endpointId);
  if (!endpoint) return null;
  return queueFor(deps, [endpoint], {
    payload: { event: WEBHOOK_TEST_EVENT, meeting: null },
    meetingId: null,
  });
}

/**
 * Retry now: a pending or parked delivery goes at once. Its attempt count
 * stays, so a parked delivery that fails again is parked again. Answers
 * false when the delivery was not pending or parked.
 */
export async function retryNow(deps: QueueDeps, deliveryId: string, now = new Date()) {
  const rows = await deps.db
    .update(d)
    .set({ status: 'pending', nextAttemptAt: now })
    .where(
      and(
        eq(d.installId, deps.installId),
        eq(d.id, deliveryId),
        inArray(d.status, ['pending', 'parked']),
      ),
    )
    .returning({ attempts: d.attempts });
  if (!rows[0]) return false;
  await sendAttempt(deps.queue, deps.installId, deliveryId, rows[0].attempts + 1);
  return true;
}

/** Finished deliveries are kept this long. */
export const DELIVERY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** A pending delivery this far past due lost its message. */
const STRANDED_MS = 15 * 60 * 1000;

/**
 * The nightly sweep: finished deliveries over 30 days old go, and a
 * delivery whose message was lost (queue refused it, a Worker died between
 * two steps) gets a new one. A duplicate message is harmless: the attempt
 * is claimed once.
 */
export async function sweepDeliveries(deps: QueueDeps, now = new Date()) {
  const { db, installId } = deps;
  const pruned = await db
    .delete(d)
    .where(
      and(
        eq(d.installId, installId),
        inArray(d.status, ['delivered', 'parked', 'cancelled']),
        lt(d.createdAt, new Date(now.getTime() - DELIVERY_KEEP_MS)),
      ),
    )
    .returning({ id: d.id });
  const stranded = await db
    .select({ id: d.id, attempts: d.attempts, status: d.status })
    .from(d)
    .where(
      and(
        eq(d.installId, installId),
        or(eq(d.status, 'pending'), eq(d.status, 'sending')),
        lt(d.nextAttemptAt, new Date(now.getTime() - STRANDED_MS)),
      ),
    )
    .limit(500);
  for (const row of stranded) {
    // A lapsed `sending` is taken over as the same attempt; a pending one makes the next.
    const attempt = row.status === 'sending' ? row.attempts : row.attempts + 1;
    await sendAttempt(deps.queue, installId, row.id, attempt);
  }
  return { pruned: pruned.length, requeued: stranded.length };
}
