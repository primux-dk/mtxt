import { describe, expect, it } from 'vitest';
import { auditStatement, cleanupEntries, recordCleanup } from '@mtxt/adapters';
import { fixtures, INSTALL, rows, testDb } from '@mtxt/adapters/test/sqlite';
import { deleteMeetingRows } from '../lib/meetings/integrity';
import { accessTo } from '../lib/meetings/queries';
import { changeShare, changeVisibility } from '../lib/meetings/sharing';

const reader = { id: 'reader', name: 'Reader', email: 'r@example.com', isAdmin: false };

function setup(visibility: 'private' | 'shared' = 'private') {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  f.user('owner');
  f.user('reader');
  f.meeting('m', { owner: 'owner', title: 'Budget', visibility });
  const meeting = async () =>
    (await db.query.meetings.findFirst({ where: (t, { eq }) => eq(t.id, 'm') }))!;
  const failAudit = () =>
    sqlite.exec(
      "CREATE TRIGGER no_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
  const count = (sql: string) => rows<{ n: number }>(sqlite, sql)[0]!.n;
  return { db, sqlite, f, meeting, failAudit, count };
}

describe('a change and its audit row land together (D1 batch)', () => {
  it('a failed audit insert leaves the visibility as it was, and the reader out', async () => {
    const t = setup();
    t.failAudit();
    await expect(changeVisibility(t.db, INSTALL, await t.meeting(), 'company')).rejects.toThrow();
    expect((await t.meeting()).visibility).toBe('private');
    expect(await accessTo(t.db, INSTALL, await t.meeting(), reader)).toBeNull();
    expect(t.count('select count(*) as n from audit_events')).toBe(0);
  });

  it('a failed audit insert leaves no share behind', async () => {
    const t = setup('shared');
    t.failAudit();
    await expect(changeShare(t.db, INSTALL, await t.meeting(), 'reader', true)).rejects.toThrow();
    expect(t.count('select count(*) as n from meeting_shares')).toBe(0);
    expect(await accessTo(t.db, INSTALL, await t.meeting(), reader)).toBeNull();
  });

  it('a failed audit insert keeps a share that was to be removed', async () => {
    const t = setup('shared');
    t.f.share('m', 'reader');
    t.failAudit();
    await expect(changeShare(t.db, INSTALL, await t.meeting(), 'reader', false)).rejects.toThrow();
    expect(t.count('select count(*) as n from meeting_shares')).toBe(1);
  });

  it('a failed audit insert leaves a meeting undeleted', async () => {
    const t = setup();
    t.failAudit();
    await expect(
      deleteMeetingRows(t.db, INSTALL, 'm', [
        auditStatement(t.db, INSTALL, {
          userId: 'owner',
          meetingId: null,
          meetingTitle: 'Budget',
          action: 'deleted',
        }),
      ]),
    ).rejects.toThrow();
    expect(t.count("select count(*) as n from meetings where id = 'm'")).toBe(1);
  });

  it('a failed audit insert records no storage cleanup, so no object is deleted', async () => {
    const t = setup();
    t.f.recording('r', 'm');
    t.failAudit();
    const cleanup = cleanupEntries(['recordings/test/m/r.webm']);
    await expect(
      deleteMeetingRows(t.db, INSTALL, 'm', [
        auditStatement(t.db, INSTALL, {
          userId: 'owner',
          meetingId: null,
          meetingTitle: 'Budget',
          action: 'deleted',
        }),
        recordCleanup(t.db, INSTALL, cleanup)!,
      ]),
    ).rejects.toThrow();
    expect(t.count('select count(*) as n from storage_cleanup')).toBe(0);
    expect(t.count("select count(*) as n from recordings where id = 'r'")).toBe(1);
  });

  it('a successful change writes exactly one audit row with before and after', async () => {
    const t = setup('shared');
    await changeShare(t.db, INSTALL, await t.meeting(), 'reader', true);
    await changeShare(t.db, INSTALL, await t.meeting(), 'reader', true);
    await changeVisibility(t.db, INSTALL, await t.meeting(), 'private');
    const log = rows<{ action: string; details: string }>(
      t.sqlite,
      'select action, details from audit_events order by at, action',
    );
    expect(log.map((r) => [r.action, JSON.parse(r.details)])).toEqual([
      ['shared', { before: [], after: ['reader'] }],
      ['visibility_changed', { before: 'shared', after: 'private', sharesRemoved: 1 }],
    ]);
    expect(t.count('select count(*) as n from meeting_shares')).toBe(0);
  });
});

describe('a share lands only while the meeting is Shared', () => {
  it('an add that arrives after a change to Private leaves no share, and Shared again starts empty', async () => {
    const t = setup('shared');
    // The add checked the meeting while it was Shared ...
    const seen = await t.meeting();
    // ... then the owner set it to Private before the add's insert ran.
    await changeVisibility(t.db, INSTALL, seen, 'private');
    await expect(changeShare(t.db, INSTALL, seen, 'reader', true)).rejects.toThrow();
    expect(t.count('select count(*) as n from meeting_shares')).toBe(0);
    expect(t.count("select count(*) as n from audit_events where action = 'shared'")).toBe(0);
    await changeVisibility(t.db, INSTALL, await t.meeting(), 'shared');
    expect(await accessTo(t.db, INSTALL, await t.meeting(), reader)).toBeNull();
  });

  it('a share row that slipped in under Private goes with the next change away from Shared', async () => {
    const t = setup('shared');
    const seen = await t.meeting();
    t.f.share('m', 'reader');
    await changeVisibility(t.db, INSTALL, seen, 'company');
    expect(t.count('select count(*) as n from meeting_shares')).toBe(0);
  });

  it('a visibility someone else changed meanwhile is a conflict, not an overwrite', async () => {
    const t = setup();
    const seen = await t.meeting();
    await changeVisibility(t.db, INSTALL, seen, 'company');
    await expect(changeVisibility(t.db, INSTALL, seen, 'shared')).rejects.toThrow(
      /changed meanwhile/,
    );
    expect((await t.meeting()).visibility).toBe('company');
  });
});
