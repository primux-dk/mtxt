import { describe, expect, it } from 'vitest';
import { syncSearch, type Visibility } from '@mtxt/adapters';
import { fixtures, INSTALL, testDb } from '@mtxt/adapters/test/sqlite';
import { resolveAccess } from '../lib/meetings/access';
import { parseLibraryParams } from '../lib/meetings/library-params';
import { accessTo, listMeetings, loadMeeting } from '../lib/meetings/queries';

/*
  Who reads what (docs/spec.md "Private and shared"): the owner, a colleague
  the meeting is shared with, any company member, an admin who is none of
  those, and an outsider of another install. Admin is never a bypass.
*/
const ROLES = ['owner', 'reader', 'member', 'admin', 'outsider'] as const;
type Role = (typeof ROLES)[number];

const EXPECTED: Record<Visibility, Record<Role, 'owner' | 'reader' | null>> = {
  private: { owner: 'owner', reader: null, member: null, admin: null, outsider: null },
  shared: { owner: 'owner', reader: 'reader', member: null, admin: null, outsider: null },
  company: { owner: 'owner', reader: 'reader', member: 'reader', admin: 'reader', outsider: null },
};

const user = (role: Role) => ({
  id: role,
  name: role,
  email: `${role}@example.com`,
  isAdmin: role === 'admin',
});

function setup() {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  for (const role of ROLES.filter((r) => r !== 'outsider')) f.user(role, role, role === 'admin');
  fixtures(sqlite, 'other').user('outsider');
  for (const v of ['private', 'shared', 'company'] as const) {
    f.meeting(`m-${v}`, { owner: 'owner', title: `Møde ${v}`, visibility: v });
    f.recording(`r-${v}`, `m-${v}`);
    f.transcript(`t-${v}`, `r-${v}`, [`Kapaciteten på linje 2 i det ${v} møde`]);
  }
  // A share row on every meeting: only `shared` honours it.
  for (const v of ['private', 'shared', 'company']) f.share(`m-${v}`, 'reader');
  return { db, sqlite };
}

describe('the permission matrix', () => {
  it('resolveAccess answers the table for every role of the install and visibility', () => {
    for (const [visibility, roles] of Object.entries(EXPECTED) as [
      Visibility,
      Record<Role, unknown>,
    ][]) {
      // The outsider is another install's user; accessTo refuses them before this rule.
      for (const role of ROLES.filter((r) => r !== 'outsider')) {
        const access = resolveAccess(
          { ownerId: 'owner', visibility, deletedAt: null },
          user(role),
          role === 'reader',
        );
        expect(access, `${role} on ${visibility}`).toBe(roles[role]);
      }
    }
  });

  it('the meeting page and the audio route (accessTo, loadMeeting) answer the same table', async () => {
    const { db } = setup();
    for (const visibility of ['private', 'shared', 'company'] as const) {
      for (const role of ROLES) {
        const meeting = (await db.query.meetings.findFirst({
          where: (m, { eq }) => eq(m.id, `m-${visibility}`),
        }))!;
        // The outsider's Worker runs another install.
        const installId = role === 'outsider' ? 'other' : INSTALL;
        expect(await accessTo(db, installId, meeting, user(role)), `${role} on ${visibility}`).toBe(
          EXPECTED[visibility][role],
        );
        const detail = await loadMeeting(db, installId, user(role), `m-${visibility}`);
        expect(detail?.access ?? null).toBe(EXPECTED[visibility][role]);
        // Only the owner gets the share list.
        expect(detail?.shares.length ?? 0).toBe(role === 'owner' ? 1 : 0);
      }
    }
  });

  it('search finds a segment only in meetings the role may read, admin included', async () => {
    const { db } = setup();
    for (const v of ['private', 'shared', 'company'] as const) {
      await syncSearch(db, INSTALL, {
        meetingId: `m-${v}`,
        segments: [{ id: `t-${v}-s0`, text: `Kapaciteten på linje 2 i det ${v} møde` }],
      });
    }
    for (const role of ROLES) {
      const installId = role === 'outsider' ? 'other' : INSTALL;
      const found = new Set<string>();
      for (const view of ['mine', 'shared', 'company'] as const) {
        const page = await listMeetings(
          db,
          installId,
          user(role),
          parseLibraryParams({ view, q: 'kapacitet' }),
        );
        for (const row of page.rows) {
          found.add(row.id);
          expect(row.snippet?.kind, `${role} ${row.id}`).toBe('segment');
          expect(row.snippet?.snippet).toContain('\u0002Kapaciteten\u0003');
        }
      }
      const expected = (['private', 'shared', 'company'] as const)
        .filter((v) => EXPECTED[v][role])
        .map((v) => `m-${v}`);
      expect([...found].sort(), role).toEqual(expected.sort());
    }
  });

  it('counts and pages only what the scope lets through', async () => {
    const { db, sqlite } = setup();
    const f = fixtures(sqlite);
    for (let i = 0; i < 30; i++) {
      f.meeting(`p-${i}`, { owner: 'owner', title: `Privat ${i}` });
      await syncSearch(db, INSTALL, {
        meetingId: `p-${i}`,
        segments: [{ id: `p-${i}-s`, text: 'kapacitet' }],
      });
    }
    const page = await listMeetings(
      db,
      INSTALL,
      user('admin'),
      parseLibraryParams({ view: 'company', q: 'kapacitet' }),
    );
    expect(page.total).toBe(0);
    const owner = await listMeetings(
      db,
      INSTALL,
      user('owner'),
      parseLibraryParams({ q: 'kapacitet' }),
    );
    expect(owner.total).toBe(30);
    expect(owner.rows).toHaveLength(25);
    expect(owner.pages).toBe(2);
  });

  it('shows a meeting retention emptied only to its owner, as deleted', async () => {
    const { db, sqlite } = setup();
    fixtures(sqlite).meeting('gone', {
      owner: 'owner',
      title: 'Gammelt møde',
      visibility: 'company',
      deletedAt: Date.UTC(2026, 9, 1),
    });
    const mine = await listMeetings(db, INSTALL, user('owner'), parseLibraryParams({}));
    expect(mine.rows.find((r) => r.id === 'gone')?.deletedAt).toEqual(
      new Date(Date.UTC(2026, 9, 1)),
    );
    // Counted in All, not as Ready.
    const ready = await listMeetings(
      db,
      INSTALL,
      user('owner'),
      parseLibraryParams({ status: 'ready' }),
    );
    expect(ready.rows.some((r) => r.id === 'gone')).toBe(false);
    const company = await listMeetings(
      db,
      INSTALL,
      user('member'),
      parseLibraryParams({ view: 'company' }),
    );
    expect(company.rows.some((r) => r.id === 'gone')).toBe(false);
    expect(await loadMeeting(db, INSTALL, user('owner'), 'gone')).toBeNull();
  });

  it("keeps an archived meeting that retention emptied in its owner's Archived view, with Remove", async () => {
    const { db, sqlite } = setup();
    sqlite
      .prepare(
        'INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility, archived_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('arch-gone', INSTALL, 'owner', 'Arkiveret', 'arkiveret', 1, 'private', 2, 3);
    const views = async () =>
      Object.fromEntries(
        await Promise.all(
          (['mine', 'shared', 'company', 'archived'] as const).map(async (view) => [
            view,
            (await listMeetings(db, INSTALL, user('owner'), parseLibraryParams({ view }))).rows
              .filter((r) => r.id === 'arch-gone')
              .map((r) => Boolean(r.deletedAt)),
          ]),
        ),
      );
    expect(await views()).toEqual({ mine: [], shared: [], company: [], archived: [true] });
    // Nobody else sees it, in any view.
    const other = await listMeetings(
      db,
      INSTALL,
      user('member'),
      parseLibraryParams({ view: 'archived' }),
    );
    expect(other.rows.some((r) => r.id === 'arch-gone')).toBe(false);
  });

  it('documents the user may not see change neither the count nor the order of those they may', async () => {
    const { db, sqlite } = setup();
    const f = fixtures(sqlite);
    // Two visible meetings: A with one "alpha" in its transcript, B with two.
    f.meeting('A', { owner: 'owner', title: 'A', startedAt: Date.UTC(2026, 9, 2) });
    f.meeting('B', { owner: 'owner', title: 'B', startedAt: Date.UTC(2026, 9, 1) });
    await syncSearch(db, INSTALL, { meetingId: 'A', segments: [{ id: 'a1', text: 'alpha beta' }] });
    await syncSearch(db, INSTALL, {
      meetingId: 'B',
      segments: [{ id: 'b1', text: 'alpha og alpha igen' }],
    });
    const visible = async () => {
      const page = await listMeetings(
        db,
        INSTALL,
        user('owner'),
        parseLibraryParams({ q: 'alpha' }),
      );
      return { total: page.total, order: page.rows.map((r) => r.id) };
    };
    const before = await visible();
    expect(before).toEqual({ total: 2, order: ['B', 'A'] });
    // 100 private documents of someone else, full of the word.
    for (let i = 0; i < 100; i++) {
      f.meeting(`x${i}`, { owner: 'member', title: `X${i}` });
      await syncSearch(db, INSTALL, {
        meetingId: `x${i}`,
        segments: [{ id: `x${i}-s`, text: i % 2 ? 'alpha' : 'alpha beta beta beta' }],
      });
    }
    expect(await visible()).toEqual(before);
  });

  it('ranks a meeting by its best document alone; the snippet comes from that document', async () => {
    const { db, sqlite } = setup();
    const f = fixtures(sqlite);
    // A: one word in its recap, twenty in one transcript segment. B: two in its recap.
    f.meeting('A', { owner: 'owner', title: 'A', startedAt: Date.UTC(2026, 9, 3) });
    f.meeting('B', { owner: 'owner', title: 'B', startedAt: Date.UTC(2026, 9, 1) });
    await syncSearch(db, INSTALL, {
      meetingId: 'A',
      recap: { id: 'ca', bodyMd: 'Referat: omega nævnes her.' },
      segments: [{ id: 'sa', text: Array.from({ length: 20 }, () => 'omega').join(' ') }],
    });
    await syncSearch(db, INSTALL, {
      meetingId: 'B',
      recap: { id: 'cb', bodyMd: 'Referat: omega og omega igen.' },
    });
    const page = await listMeetings(db, INSTALL, user('owner'), parseLibraryParams({ q: 'omega' }));
    expect(page.rows.map((r) => r.id)).toEqual(['B', 'A']);
    const a = page.rows.find((r) => r.id === 'A')!;
    expect(a.snippet?.kind).toBe('recap');
    expect(a.snippet?.snippet.split('\u0002')).toHaveLength(2);
    // A title hit outranks both, and shows no snippet.
    f.meeting('C', { owner: 'owner', title: 'Omega-møde', startedAt: Date.UTC(2026, 8, 1) });
    await syncSearch(db, INSTALL, {
      meetingId: 'C',
      title: 'Omega-møde',
      segments: [{ id: 'sc', text: 'omega' }],
    });
    const again = await listMeetings(
      db,
      INSTALL,
      user('owner'),
      parseLibraryParams({ q: 'omega' }),
    );
    expect(again.rows.map((r) => r.id)).toEqual(['C', 'B', 'A']);
    expect(again.rows[0]!.snippet).toBeUndefined();
  });
});
