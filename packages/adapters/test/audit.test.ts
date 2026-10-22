import { describe, expect, it } from 'vitest';
import { audit, detachAuditRows, OPENED_WINDOW_MS } from '../src/db/audit';
import { fixtures, INSTALL, rows, testDb } from './sqlite';

function setup() {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  f.user('owner');
  f.user('reader');
  f.meeting('m1', { owner: 'owner', title: 'Budget', visibility: 'company' });
  f.meeting('m2', { owner: 'owner', title: 'Plan', visibility: 'company' });
  return { db, sqlite };
}

const opened = (meetingId: string, at: number, userId = 'reader') => ({
  userId,
  meetingId,
  meetingTitle: 'Budget',
  action: 'opened' as const,
  at: new Date(at),
});

describe('audit()', () => {
  it('writes one opened row per user, meeting and hour', async () => {
    const { db, sqlite } = setup();
    const t = Date.UTC(2026, 9, 22, 9);
    expect(await audit(db, INSTALL, opened('m1', t))).toBe(true);
    expect(await audit(db, INSTALL, opened('m1', t + 1000))).toBe(false);
    expect(await audit(db, INSTALL, opened('m1', t + OPENED_WINDOW_MS - 1))).toBe(false);
    // Another meeting, another user: their own rows.
    expect(await audit(db, INSTALL, opened('m2', t + 1000))).toBe(true);
    expect(await audit(db, INSTALL, opened('m1', t + 1000, 'owner'))).toBe(true);
    // An hour after the first, the next open counts again.
    expect(await audit(db, INSTALL, opened('m1', t + OPENED_WINDOW_MS + 1))).toBe(true);
    const list = rows<{ meeting_id: string; user_id: string; meeting_title: string }>(
      sqlite,
      "select meeting_id, user_id, meeting_title from audit_events where action = 'opened' order by at",
    );
    expect(list).toHaveLength(4);
    expect(list[0]).toEqual({ meeting_id: 'm1', user_id: 'reader', meeting_title: 'Budget' });
  });

  it('does not let another install’s rows stand in for this one’s', async () => {
    const { db, sqlite } = setup();
    const t = Date.UTC(2026, 9, 22, 9);
    sqlite.exec(
      `INSERT INTO audit_events (id, install_id, user_id, meeting_id, action, at) VALUES ('x', 'other', 'reader', 'm1', 'opened', ${t})`,
    );
    expect(await audit(db, INSTALL, opened('m1', t + 1000))).toBe(true);
  });

  it('always writes the other actions, with details as JSON', async () => {
    const { db, sqlite } = setup();
    const at = new Date(Date.UTC(2026, 9, 22, 9));
    for (let i = 0; i < 2; i++) {
      await audit(db, INSTALL, {
        userId: 'owner',
        meetingId: 'm1',
        meetingTitle: 'Budget',
        action: 'visibility_changed',
        details: { before: 'private', after: 'shared' },
        at,
      });
    }
    await audit(db, INSTALL, {
      userId: 'owner',
      meetingId: 'm1',
      meetingTitle: 'Budget',
      action: 'shared',
      details: { before: [], after: ['reader'] },
      at,
    });
    const list = rows<{ action: string; details: string; install_id: string }>(
      sqlite,
      'select action, details, install_id from audit_events order by action',
    );
    expect(list.map((r) => r.action)).toEqual([
      'shared',
      'visibility_changed',
      'visibility_changed',
    ]);
    expect(JSON.parse(list[0]!.details)).toEqual({ before: [], after: ['reader'] });
    expect(list.every((r) => r.install_id === INSTALL)).toBe(true);
  });

  it('keeps the rows, detached, when the meeting goes', async () => {
    const { db, sqlite } = setup();
    await audit(db, INSTALL, opened('m1', Date.now()));
    await detachAuditRows(db, INSTALL, 'm1');
    sqlite.exec("DELETE FROM meetings WHERE id = 'm1'");
    expect(rows(sqlite, 'select meeting_id, meeting_title from audit_events')).toEqual([
      { meeting_id: null, meeting_title: 'Budget' },
    ]);
  });
});
