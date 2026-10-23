import 'server-only';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  foldTitle,
  ftsQuery,
  schema,
  searchHitsSql,
  searchSnippets,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  type Db,
  type Meeting,
} from '@mtxt/adapters';
import type { SessionUser } from '../auth/session';
import { HttpError } from '../http-error';
import type { View } from '../meetings/library-params';
import {
  accessTo,
  listShares,
  speakersFor,
  STATE_SQL,
  viewScope,
  type MeetingState,
} from '../meetings/queries';
import { loadRecap, type VersionInfo } from '../recap/store';
import type { ListParams } from './rules';

/*
  What the REST API reads (docs/spec.md "API"), held to the same
  permission rule as the library: every row is one the token's user may
  read, written as SQL, so a list or a search never sees past it. Admins
  get nothing extra.
*/

type ApiView = ListParams['view'];
type ApiStatus = NonNullable<ListParams['status']>;

/** A meeting in a list, as the contract's MeetingSummary. */
export interface MeetingSummary {
  id: string;
  title: string;
  started_at: string;
  visibility: Meeting['visibility'];
  access: 'owner' | 'reader';
  owner: { id: string; name: string; email: string };
  state: MeetingState;
  duration_s: number | null;
  archived: boolean;
  keep: boolean;
  deleted_at: string | null;
  speakers: string[];
  has_transcript: boolean;
  has_recap: boolean;
}

/** A recap version as the API names it. */
export interface RecapVersionView {
  id: string;
  number: number;
  author: { id: string; name: string } | null;
  created_at: string;
  note: string | null;
}

export const recapVersionView = (v: VersionInfo): RecapVersionView => ({
  id: v.id,
  number: v.number,
  author: v.authorId ? { id: v.authorId, name: v.authorName ?? '' } : null,
  created_at: v.createdAt.toISOString(),
  note: v.note,
});

/**
 * Every meeting the user may read: their own (archived ones too), company
 * ones, and shared ones they are named on. A meeting retention has emptied
 * is left out; the owner's `mine` and `archived` views still show it.
 */
function scope(installId: string, user: Pick<SessionUser, 'id'>, view: ApiView): SQL {
  if (view !== 'all') return viewScope(installId, user, { view: view as View });
  return sql`m.install_id = ${installId} and m.deleted_at is null and (
    m.owner_id = ${user.id} or m.visibility = 'company' or (m.visibility = 'shared'
      and exists (select 1 from meeting_shares s
        where s.install_id = ${installId} and s.meeting_id = m.id and s.user_id = ${user.id})))`;
}

interface Row {
  id: string;
  title: string;
  started_at: number;
  visibility: Meeting['visibility'];
  owner_id: string;
  owner_name: string | null;
  owner_email: string | null;
  archived_at: number | null;
  deleted_at: number | null;
  keep: number;
  duration_s: number | null;
  state: MeetingState | 'deleted';
  has_transcript: number;
  has_recap: number;
  kind_rank: number | null;
}

export interface MeetingQuery {
  view: ApiView;
  q?: string;
  status?: ApiStatus;
  /** Meetings that started at or after this time. */
  since?: Date;
  limit: number;
  /** Newest first, after this row (`date`), or this many rows in (`relevance`, search). */
  after?: { startedAt: number; id: string };
  offset?: number;
  order: 'date' | 'relevance';
  /** Just this meeting, still under the permission scope. */
  only?: string;
}

/** One page of meetings for the user, one row more than asked, so the caller knows whether more follow. */
export async function queryMeetings(
  db: Db,
  installId: string,
  user: Pick<SessionUser, 'id'>,
  query: MeetingQuery,
): Promise<{ rows: MeetingSummary[]; ranks: Map<string, number>; more: boolean }> {
  const match = query.q ? ftsQuery(query.q) : null;
  const hits = query.q
    ? searchHitsSql(installId, match, `%${foldTitle(query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    : null;
  const filters: SQL[] = [scope(installId, user, query.view)];
  if (query.status === 'transcribing')
    filters.push(sql`${STATE_SQL} in ('transcribing', 'uploading')`);
  else if (query.status) filters.push(sql`${STATE_SQL} = ${query.status}`);
  if (query.since) filters.push(sql`m.started_at >= ${query.since.getTime()}`);
  if (query.only) filters.push(sql`m.id = ${query.only}`);
  if (query.after) {
    filters.push(sql`(m.started_at < ${query.after.startedAt}
      or (m.started_at = ${query.after.startedAt} and m.id > ${query.after.id}))`);
  }
  const order =
    query.order === 'relevance' && hits
      ? sql`h.kind_rank asc, h.hits desc, m.started_at desc, m.id`
      : sql`m.started_at desc, m.id`;
  const rows = await db.all<Row>(sql`${hits ? sql`with hits as (${hits}) ` : sql``}
    select m.id, m.title, m.started_at, m.visibility, m.owner_id, m.archived_at, m.deleted_at, m.keep,
      u.name as owner_name, u.email as owner_email, r.duration_s, ${STATE_SQL} as state,
      ${hits ? sql`h.kind_rank` : sql`null`} as kind_rank,
      exists (select 1 from transcripts t join recordings r4 on r4.id = t.recording_id and r4.install_id = ${installId}
        where t.install_id = ${installId} and r4.meeting_id = m.id and t.status = 'done' and t.is_comparison = 0)
        as has_transcript,
      exists (select 1 from recaps c where c.install_id = ${installId} and c.meeting_id = m.id
        and c.current_version_id is not null) as has_recap
    from meetings m
    ${hits ? sql`join hits h on h.meeting_id = m.id` : sql``}
    left join users u on u.id = m.owner_id and u.install_id = ${installId}
    left join recordings r on r.id = (
      select r2.id from recordings r2 where r2.install_id = ${installId} and r2.meeting_id = m.id
      order by r2.is_primary desc, r2.created_at desc limit 1)
    where ${sql.join(filters, sql` and `)}
    order by ${order}
    limit ${query.limit + 1} offset ${query.offset ?? 0}`);
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const speakers = await speakersFor(
    db,
    installId,
    page.map((r) => r.id),
  );
  const ranks = new Map(page.map((r) => [r.id, Number(r.kind_rank ?? 0)]));
  return {
    rows: page.map((r) => ({
      id: r.id,
      title: r.title,
      started_at: new Date(Number(r.started_at)).toISOString(),
      visibility: r.visibility,
      access: r.owner_id === user.id ? 'owner' : 'reader',
      owner: {
        id: r.owner_id,
        name: r.owner_name || r.owner_email || '',
        email: r.owner_email ?? '',
      },
      state: r.state === 'deleted' ? 'none' : r.state,
      duration_s: r.duration_s === null ? null : Number(r.duration_s),
      archived: r.archived_at !== null,
      keep: Boolean(Number(r.keep)),
      deleted_at: r.deleted_at === null ? null : new Date(Number(r.deleted_at)).toISOString(),
      speakers: (speakers.get(r.id) ?? []).map((s) => s.name),
      has_transcript: Boolean(Number(r.has_transcript)),
      has_recap: Boolean(Number(r.has_recap)),
    })),
    ranks,
    more,
  };
}

/** A snippet as parts: the text around the hit, each part a hit or not. Plain text, never markup. */
export type SnippetPart = { text: string; hit: boolean };

export function snippetParts(marked: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let text = '';
  for (const char of marked) {
    if (char === SNIPPET_OPEN || char === SNIPPET_CLOSE) {
      if (text) parts.push({ text, hit });
      text = '';
      hit = char === SNIPPET_OPEN;
    } else text += char;
  }
  if (text) parts.push({ text, hit });
  return parts;
}

const MATCHES = ['title', 'recap', 'transcript'] as const;

/** The search's snippets for a page of meetings it found, best document per meeting. */
export async function searchResults(
  db: Db,
  installId: string,
  q: string,
  page: { rows: MeetingSummary[]; ranks: Map<string, number> },
) {
  const match = ftsQuery(q);
  // A title hit shows no snippet: the meeting's title is the hit.
  const withText = page.rows.filter((r) => (page.ranks.get(r.id) ?? 0) !== 0).map((r) => r.id);
  const snippets =
    match && withText.length ? await searchSnippets(db, installId, match, withText) : new Map();
  return page.rows.map((meeting) => {
    const rank = page.ranks.get(meeting.id) ?? 0;
    const hit = snippets.get(meeting.id);
    return {
      meeting,
      match: MATCHES[rank] ?? 'title',
      snippet: rank !== 0 && hit ? snippetParts(hit.snippet) : null,
      start_s: rank !== 0 && hit ? hit.startS : null,
    };
  });
}

/**
 * The meeting a REST call is about, for its user: 404 when they may not
 * read it (as if it did not exist), 403 when they may read it but the call
 * needs the owner.
 */
export async function restMeeting(
  db: Db,
  installId: string,
  user: SessionUser,
  meetingId: string,
  need: 'read' | 'owner',
): Promise<{ meeting: Meeting; access: 'owner' | 'reader' }> {
  const meeting = await db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, meetingId), eq(schema.meetings.installId, installId)),
  });
  const access = meeting ? await accessTo(db, installId, meeting, user) : null;
  if (!meeting || !access) throw new HttpError(404, 'not_found', 'No such meeting.');
  if (need === 'owner' && access !== 'owner')
    throw new HttpError(403, 'forbidden', 'Only the owner changes a meeting.');
  return { meeting, access };
}

/** One meeting in full, as the contract's MeetingDetail. */
export async function meetingDetail(
  db: Db,
  installId: string,
  user: SessionUser,
  meeting: Meeting,
  access: 'owner' | 'reader',
) {
  const [summary] = (
    await queryMeetings(db, installId, user, {
      view: 'all',
      only: meeting.id,
      limit: 1,
      order: 'date',
    })
  ).rows;
  if (!summary) throw new HttpError(404, 'not_found', 'No such meeting.');
  const t = schema.transcripts;
  const r = schema.recordings;
  const [recordings, transcript, recap, shares] = await Promise.all([
    db
      .select({
        id: r.id,
        status: r.status,
        source: r.source,
        duration_s: r.durationS,
        is_primary: r.isPrimary,
        created_at: r.createdAt,
        confirmed_at: r.confirmedAt,
      })
      .from(r)
      .where(and(eq(r.installId, installId), eq(r.meetingId, meeting.id)))
      .orderBy(desc(r.isPrimary), desc(r.createdAt)),
    db
      .select({ status: t.status, language: t.language })
      .from(t)
      .innerJoin(r, and(eq(r.id, t.recordingId), eq(r.installId, installId)))
      .where(
        and(eq(t.installId, installId), eq(r.meetingId, meeting.id), eq(t.isComparison, false)),
      )
      .orderBy(desc(r.isPrimary), desc(t.createdAt))
      .get(),
    loadRecap(db, installId, meeting.id),
    access === 'owner' ? listShares(db, installId, meeting.id) : Promise.resolve(null),
  ]);
  return {
    ...summary,
    recordings: recordings.map((rec) => ({
      ...rec,
      created_at: rec.created_at.toISOString(),
      confirmed_at: rec.confirmed_at?.toISOString() ?? null,
    })),
    transcript: transcript ? { status: transcript.status, language: transcript.language } : null,
    recap: recap
      ? {
          status: recap.status,
          version: recap.current ? recapVersionView(recap.current) : null,
        }
      : null,
    shares,
  };
}

/** The recap's current version with its decisions, for `?format=json`. Null when it has no version. */
export async function recapJson(db: Db, installId: string, meetingId: string) {
  const recap = await loadRecap(db, installId, meetingId);
  if (!recap?.current) return null;
  const d = schema.decisions;
  const u = schema.users;
  const decisions = await db
    .select({
      position: d.position,
      text: d.text,
      done: d.done,
      ownerId: u.id,
      ownerName: u.name,
    })
    .from(d)
    .leftJoin(u, and(eq(u.id, d.ownerUserId), eq(u.installId, installId)))
    .where(and(eq(d.installId, installId), eq(d.recapId, recap.id)))
    .orderBy(asc(d.position), asc(d.id));
  return {
    meeting_id: meetingId,
    status: recap.status,
    version: recapVersionView(recap.current),
    body_md: recap.current.bodyMd,
    decisions: decisions.map((x) => ({
      position: x.position,
      text: x.text,
      done: x.done,
      owner: x.ownerId ? { id: x.ownerId, name: x.ownerName ?? '' } : null,
    })),
  };
}
