import 'server-only';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  foldTitle,
  ftsQuery,
  schema,
  searchHitsSql,
  searchSnippets,
  type Db,
  type Meeting,
  type Recording,
  type SearchHit,
} from '@mtxt/adapters';
import type { SessionUser as CurrentUser } from '../auth/session';
import { unnamedNumber } from '../transcription/speakers';
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
  /** Who spoke, for the speakers line: linked colleagues' names or the labels, in speaking order. */
  speakers: { name: string; unnamed: number | null }[];
  /** Set when retention has deleted the audio and transcript; the row is metadata only. */
  deletedAt: Date | null;
  /** The best transcript or recap hit of a search, already permission-checked. */
  snippet?: SearchHit;
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
const STATE_SQL = sql<string>`case when m.deleted_at is not null then 'deleted' else case r.status
  when 'transcribed' then 'ready'
  when 'failed' then 'failed'
  when 'uploading' then 'uploading'
  when 'confirmed' then 'transcribing'
  when 'transcribing' then 'transcribing'
  else 'none' end end`;

/** LIKE with the user's text taken literally. */
const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The permission rule as SQL, per view. A meeting retention has emptied
 * (`deleted_at`) shows only in its owner's own view, as a muted row, until
 * the owner removes it.
 */
function viewScope(installId: string, user: CurrentUser, params: LibraryParams): SQL {
  const own = sql`m.install_id = ${installId}`;
  const base = sql`${own} and m.deleted_at is null`;
  switch (params.view) {
    case 'mine':
      return sql`${own} and m.archived_at is null and m.owner_id = ${user.id}`;
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
  const where = viewScope(installId, user, params);
  // A search: titles, transcript segments and recaps, matched in the index,
  // then held to the view's permission scope by the join below, then paged.
  const query = params.q ? ftsQuery(params.q) : null;
  const hits = params.q ? searchHitsSql(installId, query, likeContains(foldTitle(params.q))) : null;
  const withHits = hits ? sql`with hits as (${hits}) ` : sql``;
  const joinHits = hits ? sql`join hits h on h.meeting_id = m.id` : sql``;
  const from = sql`from meetings m ${joinHits} left join recordings r on r.id = (
    select r2.id from recordings r2 where r2.install_id = ${installId} and r2.meeting_id = m.id
    order by r2.is_primary desc, r2.created_at desc limit 1)
    where ${where}`;

  const grouped = await db.all<{ state: string; n: number }>(
    sql`${withHits}select ${STATE_SQL} as state, count(*) as n ${from} group by state`,
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
      : params.sort === 'relevance' && hits
        ? sql`h.score asc, m.started_at desc, m.id`
        : sql`m.started_at desc, m.id`;

  const rows = await db.all<{
    id: string;
    title: string;
    started_at: number;
    visibility: Meeting['visibility'];
    duration_s: number | null;
    state: MeetingState | 'deleted';
    archived_at: number | null;
    deleted_at: number | null;
  }>(
    sql`${withHits}select m.id, m.title, m.started_at, m.visibility, m.archived_at, m.deleted_at,
      r.duration_s, ${STATE_SQL} as state
      ${from} ${statusWhere} order by ${order} limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
  );

  const speakers = await speakersFor(
    db,
    installId,
    rows.map((r) => r.id),
  );

  // Snippets only for the page's rows, which the scope has already let through.
  const snippets =
    query && rows.length
      ? await searchSnippets(
          db,
          installId,
          query,
          rows.filter((r) => r.deleted_at === null).map((r) => r.id),
        )
      : new Map<string, SearchHit>();

  return {
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      startedAt: new Date(Number(r.started_at)),
      visibility: r.visibility,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      state: r.state === 'deleted' ? 'none' : r.state,
      archived: r.archived_at !== null,
      speakers: speakers.get(r.id) ?? [],
      deletedAt: r.deleted_at === null ? null : new Date(Number(r.deleted_at)),
      snippet: snippets.get(r.id),
    })),
    total,
    counts,
    page,
    pages,
  };
}

/**
 * The speakers of a page of meetings, in one query: the colleague's name
 * when a speaker is linked, else the label. Install-scoped on both sides.
 */
async function speakersFor(db: Db, installId: string, meetingIds: string[]) {
  const out = new Map<string, { name: string; unnamed: number | null }[]>();
  if (!meetingIds.length) return out;
  const rows = await db.all<{ meeting_id: string; label: string; user_name: string | null }>(
    sql`select s.meeting_id, s.label, u.name as user_name from speakers s
      left join users u on u.id = s.user_id and u.install_id = ${installId}
      where s.install_id = ${installId}
        and s.meeting_id in (select value from json_each(${JSON.stringify(meetingIds)}))
      order by s.meeting_id, coalesce(s.speaker_index, 1000000), s.label`,
  );
  for (const row of rows) {
    const list = out.get(row.meeting_id) ?? [];
    list.push(
      row.user_name
        ? { name: row.user_name, unnamed: null }
        : { name: row.label, unnamed: unnamedNumber(row.label) },
    );
    out.set(row.meeting_id, list);
  }
  return out;
}

export interface MeetingDetail {
  meeting: Meeting;
  access: Exclude<Access, null>;
  recordings: Recording[];
  /** The recording the page plays and shows the state of: primary, else the latest. */
  current: Recording | null;
  hasRecap: boolean;
  hasTranscript: boolean;
  /** The colleagues the meeting is shared with, for its owner; empty for anyone else. */
  shares: Colleague[];
}

export interface Colleague {
  id: string;
  name: string;
  email: string;
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
  const owner = access === 'owner';
  const [recordings, recap, transcript, shares] = await Promise.all([
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
    db.get<{ id: string } | undefined>(sql`select t.id from transcripts t
      join recordings r on r.id = t.recording_id and r.install_id = ${installId}
      where t.install_id = ${installId} and r.meeting_id = ${meeting.id} limit 1`),
    owner ? listShares(db, installId, meeting.id) : Promise.resolve([]),
  ]);
  return {
    meeting,
    access,
    recordings,
    current: recordings[0] ?? null,
    hasRecap: Boolean(recap),
    hasTranscript: Boolean(transcript),
    shares,
  };
}

/** Who a meeting is shared with, by name. Users of this install only. */
export async function listShares(db: Db, installId: string, meetingId: string) {
  const s = schema.meetingShares;
  const u = schema.users;
  return db
    .select({ id: u.id, name: u.name, email: u.email })
    .from(s)
    .innerJoin(u, and(eq(u.id, s.userId), eq(u.installId, installId)))
    .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)))
    .orderBy(u.name, u.email);
}
