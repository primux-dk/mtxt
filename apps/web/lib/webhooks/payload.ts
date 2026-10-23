/*
  The webhook payload (docs/spec.md "Webhooks", Payload). Metadata and
  signed links, never content: no transcript text, no recap text. Built at
  every attempt, so a retry carries fresh links and the current title.
*/
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Db, type Visibility, type WebhookEvent } from '@mtxt/adapters';
import { createGrant, grantExpiry, type GrantFormat } from './grant';

export interface MeetingMeta {
  id: string;
  title: string;
  started_at: string;
  /** The primary recording's length; null when the meeting has no recording. */
  duration_s: number | null;
  visibility: Visibility;
  owner: { name: string; email: string };
}

export interface Links {
  transcript: string | null;
  recap_markdown: string | null;
  recap_docx: string | null;
}

/** `meeting.deleted` says which meeting and when, nothing else (docs/spec.md "Webhooks"). */
export interface DeletedNotice {
  id: string;
  deleted_at: string;
}

export interface WebhookPayload {
  event: WebhookEvent | 'webhook.test';
  sent_at: string;
  install: { product_name: string };
  meeting: MeetingMeta | DeletedNotice | null;
  links: Links | null;
  expires_at: string | null;
}

const NO_LINKS: Links = { transcript: null, recap_markdown: null, recap_docx: null };

/** The meeting's metadata for a payload, or null when the meeting is not this install's. */
export async function meetingMeta(
  db: Db,
  installId: string,
  meetingId: string,
): Promise<(MeetingMeta & { ownerId: string }) | null> {
  const m = schema.meetings;
  const u = schema.users;
  const row = await db
    .select({
      id: m.id,
      title: m.title,
      startedAt: m.startedAt,
      visibility: m.visibility,
      ownerId: m.ownerId,
      ownerName: u.name,
      ownerEmail: u.email,
    })
    .from(m)
    .innerJoin(u, and(eq(u.id, m.ownerId), eq(u.installId, installId)))
    .where(and(eq(m.id, meetingId), eq(m.installId, installId)))
    .get();
  if (!row) return null;
  const r = schema.recordings;
  const recording = await db
    .select({ durationS: r.durationS })
    .from(r)
    .where(and(eq(r.installId, installId), eq(r.meetingId, meetingId)))
    .orderBy(desc(r.isPrimary), desc(r.createdAt))
    .get();
  return {
    id: row.id,
    title: row.title,
    started_at: row.startedAt.toISOString(),
    duration_s: recording?.durationS ?? null,
    visibility: row.visibility,
    owner: { name: row.ownerName, email: row.ownerEmail },
    ownerId: row.ownerId,
  };
}

/** What there is to fetch now: a done transcript, a recap version. */
export async function available(db: Db, installId: string, meetingId: string) {
  const row = await db.get<{ transcript: number; recap: number }>(sql`
    select
      exists (select 1 from transcripts t join recordings r on r.id = t.recording_id and r.install_id = ${installId}
        where t.install_id = ${installId} and r.meeting_id = ${meetingId} and t.status = 'done'
          and t.is_comparison = 0) as transcript,
      exists (select 1 from recaps c where c.install_id = ${installId} and c.meeting_id = ${meetingId}
        and c.current_version_id is not null) as recap`);
  return { transcript: Boolean(row?.transcript), recap: Boolean(row?.recap) };
}

/** `${origin}/api/v1/export/${token}` for each format there is something to fetch for. */
export async function signedLinks(input: {
  settingsKey: string;
  origin: string;
  meetingId: string;
  endpointId: string;
  now: Date;
  has: { transcript: boolean; recap: boolean };
}): Promise<{ links: Links; expiresAt: Date }> {
  const expiresAt = grantExpiry(input.now);
  const link = async (format: GrantFormat) =>
    `${input.origin}/api/v1/export/${await createGrant(input.settingsKey, {
      meetingId: input.meetingId,
      format,
      endpointId: input.endpointId,
      expiresAt,
    })}`;
  return {
    links: {
      transcript: input.has.transcript ? await link('transcript') : null,
      recap_markdown: input.has.recap ? await link('md') : null,
      recap_docx: input.has.recap ? await link('docx') : null,
    },
    expiresAt: new Date(expiresAt * 1000),
  };
}

export function buildPayload(input: {
  event: WebhookPayload['event'];
  now: Date;
  productName: string;
  meeting?: MeetingMeta | null;
  deleted?: DeletedNotice;
  links?: Links | null;
  expiresAt?: Date | null;
}): WebhookPayload {
  const base = {
    event: input.event,
    sent_at: input.now.toISOString(),
    install: { product_name: input.productName },
  };
  if (input.deleted) {
    return {
      ...base,
      meeting: { id: input.deleted.id, deleted_at: input.deleted.deleted_at },
      links: null,
      expires_at: null,
    };
  }
  const meeting = input.meeting
    ? {
        id: input.meeting.id,
        title: input.meeting.title,
        started_at: input.meeting.started_at,
        duration_s: input.meeting.duration_s,
        visibility: input.meeting.visibility,
        owner: { name: input.meeting.owner.name, email: input.meeting.owner.email },
      }
    : null;
  return {
    ...base,
    meeting,
    links: meeting ? (input.links ?? NO_LINKS) : null,
    expires_at: meeting && input.expiresAt ? input.expiresAt.toISOString() : null,
  };
}
