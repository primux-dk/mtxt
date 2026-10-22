import 'server-only';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { foldTitle, schema, type Db, type Meeting, type Recording } from '@mtxt/adapters';
import type { SessionUser as CurrentUser } from '../auth/session';
import { resolveAccess, type Access } from './access';
import { PAGE_SIZE, type LibraryParams, type StatusFilter } from './library-params';

/** What a meeting shows in the library and the header, from its primary or latest recording. */
export type MeetingState = 'ready' | 'transcribing' | 'uploading' | 'failed' | 'none';

export function meetingState(status: Recording['status'] | null | undefined): MeetingState {
  switch (status) {
    case 'transcribed':
      return 'ready';
    case 'confirmed':
    case 'transcribing':
      return 'transcribing';
    case 'uploading':
      return 'uploading';
    case 'failed':
      return 'failed';
    default:
      return 'none';
  }
}

export interface LibraryRow {
  id: string;
  title: string;
  startedAt: Date;
  visibility: Meeting['visibility'];
  durationS: number | null;
  state: MeetingState;
  archived: boolean;
}

export interface LibraryPage {
  rows: LibraryRow[];
  /** Meetings matching the view, search and status filter. */
  total: number;
  /** Per status pill, for the view and search without the status filter. */
  counts: Record<'all' | StatusFilter, number>;
  page: number;
  pages: number;
}

const m = schema.meetings;
const STATE_SQL = sql<string>`case r.status
  when 'transcribed' then 'ready'
  when 'failed' then 'failed'
  when 'uploading' then 'uploading'
  when 'confirmed' then 'transcribing'
  when 'transcribing' then 'transcribing'
  else 'none' end`;

/** LIKE with the user's text taken literally. */
const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function viewScope(installId: string, user: CurrentUser, params: LibraryParams): SQL {
  const base = sql`m.install_id = ${installId} and m.deleted_at is null`;
  switch (params.view) {
    case 'mine':
      return sql`${base} and m.archived_at is null and m.owner_id = ${user.id}`;
    case 'shared':
      return sql`${base} and m.archived_at is null and m.visibility = 'shared' and m.owner_id != ${user.id}
        and exists (select 1 from meeting_shares s
          where s.install_id = ${installId} and s.meeting_id = m.id and s.user_id = ${user.id})`;
    case 'company':
      return sql`${base} and m.archived_at is null and m.visibility = 'company'`;
    case 'archived':
      return sql`${base} and m.archived_at is not null and m.owner_id = ${user.id}`;
  }
}

/**
 * One page of the library for a user. Every row is one the user may read:
 * the scope is the permission rule written as SQL, so search never sees past
 * it (docs/design/README.md: search uses the same permission scope).
 */
export async function listMeetings(
  db: Db,
  installId: string,
  user: CurrentUser,
  params: LibraryParams,
): Promise<LibraryPage> {
  let where = viewScope(installId, user, params);
  if (params.q) {
    where = sql`${where} and m.title_folded like ${likeContains(foldTitle(params.q))} escape '\\'`;
  }
  const from = sql`from meetings m left join recordings r on r.id = (
    select r2.id from recordings r2 where r2.install_id = ${installId} and r2.meeting_id = m.id
    order by r2.is_primary desc, r2.created_at desc limit 1)
    where ${where}`;

  const grouped = await db.all<{ state: string; n: number }>(
    sql`select ${STATE_SQL} as state, count(*) as n ${from} group by state`,
  );
  const by = Object.fromEntries(grouped.map((g) => [g.state, Number(g.n)]));
  const counts = {
    all: grouped.reduce((n, g) => n + Number(g.n), 0),
    ready: by.ready ?? 0,
    transcribing: (by.transcribing ?? 0) + (by.uploading ?? 0),
    failed: by.failed ?? 0,
  };
  const total = params.status ? counts[params.status] : counts.all;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(params.page, pages);

  const statusWhere = !params.status
    ? sql``
    : params.status === 'transcribing'
      ? sql`and ${STATE_SQL} in ('transcribing', 'uploading')`
      : sql`and ${STATE_SQL} = ${params.status}`;
  const order =
    params.sort === 'title'
      ? sql`m.title_folded asc, m.started_at desc, m.id`
      : sql`m.started_at desc, m.id`;

  const rows = await db.all<{
    id: string;
    title: string;
    started_at: number;
    visibility: Meeting['visibility'];
    duration_s: number | null;
    state: MeetingState;
    archived_at: number | null;
  }>(
    sql`select m.id, m.title, m.started_at, m.visibility, m.archived_at, r.duration_s, ${STATE_SQL} as state
      ${from} ${statusWhere} order by ${order} limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      startedAt: new Date(Number(r.started_at)),
      visibility: r.visibility,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      state: r.state,
      archived: r.archived_at !== null,
    })),
    total,
    counts,
    page,
    pages,
  };
}

export interface MeetingDetail {
  meeting: Meeting;
  access: Exclude<Access, null>;
  recordings: Recording[];
  /** The recording the page plays and shows the state of: primary, else the latest. */
  current: Recording | null;
  hasRecap: boolean;
}

/** The user's access to a meeting: resolveAccess with the share looked up. */
export async function accessTo(
  db: Db,
  installId: string,
  meeting: Pick<Meeting, 'id' | 'installId' | 'ownerId' | 'visibility' | 'deletedAt'>,
  user: CurrentUser,
): Promise<Access> {
  // A row from another install is nobody's here, whatever it points at.
  if (meeting.installId !== installId) return null;
  let shared = false;
  if (meeting.ownerId !== user.id && meeting.visibility === 'shared') {
    shared = Boolean(
      await db.query.meetingShares.findFirst({
        where: and(
          eq(schema.meetingShares.installId, installId),
          eq(schema.meetingShares.meetingId, meeting.id),
          eq(schema.meetingShares.userId, user.id),
        ),
      }),
    );
  }
  return resolveAccess(meeting, user, shared);
}

/** A meeting the user may read, with its recordings; null when there is none (or it is not theirs to see). */
export async function loadMeeting(
  db: Db,
  installId: string,
  user: CurrentUser,
  meetingId: string,
): Promise<MeetingDetail | null> {
  const meeting = await db.query.meetings.findFirst({
    where: and(eq(m.id, meetingId), eq(m.installId, installId)),
  });
  if (!meeting) return null;
  const access = await accessTo(db, installId, meeting, user);
  if (!access) return null;
  const [recordings, recap] = await Promise.all([
    db.query.recordings.findMany({
      where: and(
        eq(schema.recordings.installId, installId),
        eq(schema.recordings.meetingId, meeting.id),
      ),
      orderBy: [desc(schema.recordings.isPrimary), desc(schema.recordings.createdAt)],
    }),
    db.query.recaps.findFirst({
      where: and(eq(schema.recaps.installId, installId), eq(schema.recaps.meetingId, meeting.id)),
    }),
  ]);
  return { meeting, access, recordings, current: recordings[0] ?? null, hasRecap: Boolean(recap) };
}
