import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtures, INSTALL, testDb } from '@mtxt/adapters/test/sqlite';
import { seedSql, type Job } from '@mtxt/adapters';
import { widens } from '../lib/webhooks/rules';

/*
  `meeting.shared` goes out only when access widens (packet 13, Codex
  review): private to shared or company, shared to company, or a reader
  added. Narrowing and a removed reader send nothing. The session and the
  adapters are mocked; the database is the D1 driver on node:sqlite.
*/
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; isAdmin: boolean },
  db: null as unknown,
  sent: [] as Job[],
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: async () => state.user }));
vi.mock('@/lib/install', () => ({
  getAdapters: async () => ({
    db: state.db,
    installId: INSTALL,
    queue: { send: async (job: Job) => void state.sent.push(job), sendBatch: async () => {} },
  }),
}));

const { setShare, setVisibility } = await import('../app/(app)/meetings/sharing-actions');

describe('meeting.shared', () => {
  let sqlite: ReturnType<typeof testDb>['sqlite'];

  beforeEach(() => {
    const ctx = testDb();
    sqlite = ctx.sqlite;
    state.db = ctx.db;
    state.sent = [];
    const f = fixtures(sqlite);
    f.user('owner');
    f.user('reader');
    f.meeting('m1', { owner: 'owner', visibility: 'private' });
    sqlite.exec(seedSql(INSTALL));
    sqlite.exec(`update settings set webhook_auto_send = 'shared';
      insert into webhook_endpoints (id, install_id, label, url, secret, events, enabled)
      values ('e1', '${INSTALL}', 'Alex', 'https://alex.example.com/', 'x', '["meeting.shared"]', 1)`);
    state.user = { id: 'owner', email: 'owner@example.com', name: 'owner', isAdmin: false };
  });

  /** Delivered deliveries do not absorb new ones, so each event is its own row. */
  const sentSoFar = () => {
    const n = state.sent.length;
    sqlite.exec(`update webhook_deliveries set status = 'delivered'`);
    return n;
  };

  it('widens: private to shared or company, shared to company', () => {
    expect(widens('private', 'shared')).toBe(true);
    expect(widens('private', 'company')).toBe(true);
    expect(widens('shared', 'company')).toBe(true);
    expect(widens('company', 'shared')).toBe(false);
    expect(widens('company', 'private')).toBe(false);
    expect(widens('shared', 'private')).toBe(false);
  });

  it('goes out when access widens, and never when it narrows', async () => {
    expect((await setVisibility('m1', 'shared')).ok).toBe(true);
    expect(sentSoFar()).toBe(1);
    expect((await setShare('m1', 'reader', true)).ok).toBe(true);
    expect(sentSoFar()).toBe(2);
    expect((await setShare('m1', 'reader', false)).ok).toBe(true);
    expect(sentSoFar()).toBe(2);
    expect((await setVisibility('m1', 'company')).ok).toBe(true);
    expect(sentSoFar()).toBe(3);
    expect((await setVisibility('m1', 'shared')).ok).toBe(true);
    expect(sentSoFar()).toBe(3);
    expect((await setVisibility('m1', 'private')).ok).toBe(true);
    expect(sentSoFar()).toBe(3);
  });
});
