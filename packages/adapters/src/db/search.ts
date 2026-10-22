import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Db } from './index';

/**
 * The search index: `meeting_search`, an FTS5 table made by migration 0004
 * (drizzle-kit has no virtual tables). One row per meeting title, transcript
 * segment and recap. The app keeps it in sync: whoever writes a title,
 * segments or a recap calls syncSearch() after.
 *
 * Every column but `meeting_key` and `text` is UNINDEXED. `meeting_key` is
 * one token per meeting, so a meeting's rows are found through the index.
 */
export const SEARCH_KINDS = ['title', 'segment', 'recap'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/**
 * The FTS5 table as Drizzle sees it, so writes can join a D1 batch (raw
 * statements cannot). Not in schema.ts: drizzle-kit would try to create it.
 */
export const meetingSearch = sqliteTable('meeting_search', {
  installId: text('install_id').notNull(),
  meetingId: text('meeting_id').notNull(),
  meetingKey: text('meeting_key').notNull(),
  kind: text('kind', { enum: SEARCH_KINDS }).notNull(),
  ref: text('ref').notNull(),
  text: text('text').notNull(),
});

/** 'm' and the hex of the id's UTF-8 bytes: one unicode61 token, and the same as SQLite's `'m' || lower(hex(id))`. */
export function meetingKey(meetingId: string): string {
  let hex = '';
  for (const byte of new TextEncoder().encode(meetingId)) hex += byte.toString(16).padStart(2, '0');
  return `m${hex}`;
}

export interface SearchSync {
  meetingId: string;
  /** Replaces the meeting's title row. */
  title?: string;
  /** Replaces every segment row of the meeting. `[]` removes them. */
  segments?: readonly { id: string; text: string }[];
  /** Replaces the meeting's recap row. Null, or an empty body, removes it. */
  recap?: { id: string; bodyMd: string } | null;
}

/** D1 binds at most 100 parameters per statement; a row takes 6. */
const ROWS_PER_INSERT = 16;

const s = meetingSearch;
const ofMeeting = (installId: string, meetingId: string, kinds?: readonly SearchKind[]) =>
  and(
    sql`meeting_search match ${`meeting_key : "${meetingKey(meetingId)}"`}`,
    eq(s.installId, installId),
    kinds ? inArray(s.kind, [...kinds]) : undefined,
  );

function statements(db: Db, installId: string, change: SearchSync) {
  const { meetingId } = change;
  const key = meetingKey(meetingId);
  const out = [];
  const clear = (kind: SearchKind) => db.delete(s).where(ofMeeting(installId, meetingId, [kind]));
  const insert = (rows: { kind: SearchKind; ref: string; text: string }[]) => {
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      out.push(
        db
          .insert(s)
          .values(
            rows
              .slice(i, i + ROWS_PER_INSERT)
              .map((r) => ({ installId, meetingId, meetingKey: key, ...r })),
          ),
      );
    }
  };
  if (change.title !== undefined) {
    out.push(clear('title'));
    insert([{ kind: 'title', ref: meetingId, text: change.title }]);
  }
  if (change.segments !== undefined) {
    out.push(clear('segment'));
    insert(
      change.segments
        .filter((seg) => seg.text.trim())
        .map((seg) => ({ kind: 'segment' as const, ref: seg.id, text: seg.text })),
    );
  }
  if (change.recap !== undefined) {
    out.push(clear('recap'));
    if (change.recap?.bodyMd.trim()) {
      insert([{ kind: 'recap', ref: change.recap.id, text: change.recap.bodyMd }]);
    }
  }
  return out;
}

/**
 * Brings the index in line with what was just written. Call it after the
 * write, with what changed:
 *
 *   syncSearch(db, installId, { meetingId, title })        rename, create
 *   syncSearch(db, installId, { meetingId, segments })     the transcript writer
 *   syncSearch(db, installId, { meetingId, recap })        the recap writer
 *
 * One batch, so the meeting's rows of a kind are replaced at once.
 */
export async function syncSearch(db: Db, installId: string, change: SearchSync): Promise<void> {
  const [first, ...rest] = statements(db, installId, change);
  if (first) await db.batch([first, ...rest]);
}

/** Removes a meeting's rows of the given kinds (all kinds by default); batchable. */
export function dropFromSearchStatement(
  db: Db,
  installId: string,
  meetingId: string,
  kinds?: readonly SearchKind[],
) {
  return db.delete(s).where(ofMeeting(installId, meetingId, kinds));
}

/**
 * The user's text as an FTS5 query on the `text` column: every word a
 * prefix, all of them required. Words are runs of letters and digits, the
 * way unicode61 splits; everything else is dropped, so no input is FTS
 * syntax. Null when nothing searchable is left.
 */
export function ftsQuery(input: string): string | null {
  const words =
    input
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 12) ?? [];
  if (!words.length) return null;
  return `text : (${words.map((w) => `"${w}"*`).join(' AND ')})`;
}

/** The score a title hit gets: ahead of every bm25 score, which is negative and small. */
const TITLE_SCORE = -1e9;

/**
 * A `select meeting_id, score` over every meeting in the install that the
 * search hits, best first by ascending score: a title hit (a substring of
 * `title_folded`, as before the index, or a word of the title) ahead of
 * transcript and recap hits, which rank by bm25. Not yet held to what the
 * user may see: the caller joins it to its permission scope, then pages.
 */
export function searchHitsSql(installId: string, query: string | null, titleLike: string): SQL {
  // bm25() only runs inside the full-text query itself, so that query is
  // materialised before it is grouped (SQLite would otherwise flatten it).
  const fts = query
    ? sql`select meeting_id, score from (select meeting_id,
          case when kind = 'title' then ${TITLE_SCORE} else bm25(meeting_search) end as score
        from meeting_search where meeting_search match ${query} and install_id = ${installId}
        limit -1)
      union all `
    : sql``;
  return sql`select meeting_id, min(score) as score from (
      ${fts}select id as meeting_id, ${TITLE_SCORE} as score from meetings
        where install_id = ${installId} and title_folded like ${titleLike} escape '\\'
    ) group by meeting_id`;
}

/** Marks the snippet function puts around a hit; the page turns them into <mark>. */
export const SNIPPET_OPEN = '\u0002';
export const SNIPPET_CLOSE = '\u0003';

export interface SearchHit {
  meetingId: string;
  kind: SearchKind;
  /** The text around the best hit, with SNIPPET_OPEN and SNIPPET_CLOSE around each matched word. */
  snippet: string;
  /** Where a segment hit starts in the recording, in whole seconds. */
  startS: number | null;
}

/**
 * The best snippet per meeting, for the meetings of one page. Call it only
 * with meetings the user may read: the page's rows have been through the
 * permission scope already. A segment or recap hit beats a title hit, since
 * the row already shows its title.
 */
export async function searchSnippets(
  db: Db,
  installId: string,
  query: string,
  meetingIds: readonly string[],
): Promise<Map<string, SearchHit>> {
  const out = new Map<string, SearchHit>();
  if (!meetingIds.length) return out;
  const keys = meetingIds.map((id) => `"${meetingKey(id)}"`).join(' OR ');
  const rows = await db.all<{
    meeting_id: string;
    kind: SearchKind;
    snippet: string;
    start_ms: number | null;
  }>(sql`
    with hits as materialized (
      select meeting_id, kind, ref, bm25(meeting_search) as score,
        snippet(meeting_search, 5, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', 14) as snippet
      from meeting_search
      where meeting_search match ${`(${query}) AND meeting_key : (${keys})`}
        and install_id = ${installId} and kind != 'title'
    )
    select h.meeting_id, h.kind, h.snippet, min(h.score) as score, s.start_ms
    from hits h
    left join segments s on h.kind = 'segment' and s.id = h.ref and s.install_id = ${installId}
    group by h.meeting_id`);
  for (const row of rows) {
    out.set(row.meeting_id, {
      meetingId: row.meeting_id,
      kind: row.kind,
      snippet: row.snippet,
      startS: row.start_ms === null ? null : Math.floor(Number(row.start_ms) / 1000),
    });
  }
  return out;
}
