import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ftsQuery,
  meetingKey,
  searchHitsSql,
  searchSnippets,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  syncSearch,
} from '../src/db/search';
import { fixtures, INSTALL, rows, testDb } from './sqlite';

const like = (text: string) => `%${text}%`;

function setup() {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  f.user('owner');
  f.meeting('m1', { owner: 'owner', title: 'Produktionsmøde, uge 43' });
  f.meeting('m2', { owner: 'owner', title: 'Budget' });
  f.recording('r1', 'm1');
  const segments = f.transcript('t1', 'r1', [
    'Så er vi samlet.',
    'Lad os begynde med kapaciteten på linje 2.',
    'Kapaciteten på linje 3 er god.',
  ]);
  return { db, sqlite, f, segments };
}

describe('the search index', () => {
  it('is built by migration 0004 from what is already there', () => {
    const { sqlite } = setup();
    // The fixtures were written after the migration, so only an empty index exists here;
    // a migrated database is covered by check:d1-upgrade. The table takes rows:
    expect(rows(sqlite, 'select count(*) as n from meeting_search')).toEqual([{ n: 0 }]);
  });

  it('meetingKey matches SQLite’s hex of the id', () => {
    const { sqlite } = setup();
    for (const id of ['m1', 'demo-0001', '7f3a2b1c-0000-4000-8000-000000000001', 'møde']) {
      const [row] = rows<{ k: string }>(sqlite, `select 'm' || lower(hex('${id}')) as k`);
      expect(meetingKey(id)).toBe(row!.k);
    }
  });

  it('replaces a kind of row per meeting, leaving the rest', async () => {
    const { db, sqlite, segments } = setup();
    await syncSearch(db, INSTALL, { meetingId: 'm1', title: 'Produktionsmøde, uge 43' });
    await syncSearch(db, INSTALL, { meetingId: 'm1', segments });
    await syncSearch(db, INSTALL, { meetingId: 'm2', title: 'Budget' });
    await syncSearch(db, INSTALL, { meetingId: 'm1', title: 'Ugemøde' });
    const list = rows<{ meeting_id: string; kind: string; text: string }>(
      sqlite,
      'select meeting_id, kind, text from meeting_search order by meeting_id, kind, ref',
    );
    expect(list.filter((r) => r.kind === 'title')).toEqual([
      { meeting_id: 'm1', kind: 'title', text: 'Ugemøde' },
      { meeting_id: 'm2', kind: 'title', text: 'Budget' },
    ]);
    expect(list.filter((r) => r.kind === 'segment')).toHaveLength(3);
    await syncSearch(db, INSTALL, { meetingId: 'm1', segments: [] });
    await syncSearch(db, INSTALL, { meetingId: 'm1', recap: { id: 'c1', bodyMd: '# Referat' } });
    await syncSearch(db, INSTALL, { meetingId: 'm1', recap: null });
    expect(rows(sqlite, "select count(*) as n from meeting_search where kind != 'title'")).toEqual([
      { n: 0 },
    ]);
  });

  it('writes a 4-hour transcript in statements D1 accepts', async () => {
    const { db, sqlite } = setup();
    const many = Array.from({ length: 2500 }, (_, i) => ({ id: `s${i}`, text: `ord ${i}` }));
    await syncSearch(db, INSTALL, { meetingId: 'm1', segments: many });
    expect(rows(sqlite, 'select count(*) as n from meeting_search')).toEqual([{ n: 2500 }]);
  });

  it('turns any input into a safe prefix query', () => {
    expect(ftsQuery('kapacitet linje')).toBe('text : ("kapacitet"* AND "linje"*)');
    expect(ftsQuery('"AND" OR (NEAR*')).toBe('text : ("AND"* AND "OR"* AND "NEAR"*)');
    expect(ftsQuery('%%  --')).toBeNull();
    expect(ftsQuery('MØDE')).toBe('text : ("MØDE"*)');
  });

  it('ranks title hits first, then recap, then transcript, across the install only', async () => {
    const { db, sqlite, segments } = setup();
    await syncSearch(db, INSTALL, { meetingId: 'm1', segments });
    await syncSearch(db, INSTALL, { meetingId: 'm2', title: 'Budget' });
    await syncSearch(db, INSTALL, {
      meetingId: 'm2',
      recap: { id: 'c2', bodyMd: 'Kapacitet nævnes én gang.' },
    });
    sqlite.exec(
      "INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES ('other', 'x', 'mx', 'segment', 'x', 'kapacitet kapacitet')",
    );
    const hits = (q: string) =>
      db.all<{ meeting_id: string }>(
        sql`select meeting_id from (${searchHitsSql(INSTALL, ftsQuery(q), like(q.toLocaleLowerCase()))}) order by kind_rank, hits desc, meeting_id`,
      );
    // m2's hit is in its recap, m1's in its transcript.
    expect((await hits('kapacitet')).map((h) => h.meeting_id)).toEqual(['m2', 'm1']);
    // A substring of a title still finds it, as before the index.
    expect(await hits('møde')).toEqual([{ meeting_id: 'm1' }]);
    expect(await hits('budget')).toEqual([{ meeting_id: 'm2' }]);
    expect(await hits('ingenting')).toEqual([]);
  });

  it('answers a snippet per meeting, with the time of a segment hit', async () => {
    const { db, segments } = setup();
    await syncSearch(db, INSTALL, { meetingId: 'm1', segments });
    const hits = await searchSnippets(db, INSTALL, ftsQuery('linje 2')!, ['m1', 'm2']);
    expect([...hits.keys()]).toEqual(['m1']);
    const hit = hits.get('m1')!;
    expect(hit.kind).toBe('segment');
    expect(hit.startS).toBe(10);
    expect(hit.snippet).toContain(
      `${SNIPPET_OPEN}linje${SNIPPET_CLOSE} ${SNIPPET_OPEN}2${SNIPPET_CLOSE}`,
    );
    // Only the meetings asked for.
    expect((await searchSnippets(db, INSTALL, ftsQuery('linje')!, ['m2'])).size).toBe(0);
  });
});
