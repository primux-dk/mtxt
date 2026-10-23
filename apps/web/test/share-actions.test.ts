import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

/*
  findColleagues against a real database (packet 12, Codex review): readers
  leave the answer before the 20-result cap, and the counts cover the whole
  directory. The session and the adapters are mocked.
*/
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; name: string; isAdmin: boolean },
  db: null as unknown,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/session', () => ({ getSessionUser: async () => state.user }));
vi.mock('@/lib/install', () => ({
  getAdapters: async () => ({ db: state.db, installId: INSTALL }),
}));

const { findColleagues } = await import('../app/(app)/meetings/sharing-actions');

describe('findColleagues', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;

  /** `n` colleagues named c01, c02, ...; the first `readers` of them have access. */
  const directory = (n: number, readers: number) => {
    const id = (i: number) => `c${String(i).padStart(2, '0')}`;
    for (let i = 1; i <= n; i++)
      ctx.raw
        .prepare(
          'INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id(i), INSTALL, id(i), `${id(i)}@example.com`, `Colleague ${id(i)}`);
    for (let i = 1; i <= readers; i++)
      ctx.raw
        .prepare('INSERT INTO meeting_shares (install_id, meeting_id, user_id) VALUES (?, ?, ?)')
        .run(INSTALL, 'meet-1', id(i));
  };

  beforeEach(async () => {
    ctx = await testDb();
    state.db = ctx.db;
    seedRecording(ctx.raw);
    ctx.raw.exec(`UPDATE meetings SET visibility = 'shared'`);
    state.user = { id: 'owner', email: 'owner@example.com', name: 'Mette Lund', isAdmin: false };
  });

  it('with 46 colleagues and 20 readers, answers 20 colleagues to add and counts 26', async () => {
    directory(46, 20);
    const result = await findColleagues('meet-1', '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.others).toBe(true);
    expect(result.addable).toBe(26);
    expect(result.colleagues).toHaveLength(20);
    // None of them a reader: the readers sort first and would have filled the cap.
    expect(result.colleagues.map((c) => c.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `c${21 + i}`),
    );
  });

  it('a search skips readers too', async () => {
    directory(46, 20);
    const result = await findColleagues('meet-1', 'c0');
    expect(result.ok && result.colleagues).toEqual([]);
    expect(result.ok && result.addable).toBe(26);
  });

  it('counts none to add when every colleague is a reader, and none at all when alone', async () => {
    directory(3, 3);
    expect(await findColleagues('meet-1', '')).toEqual({
      ok: true,
      colleagues: [],
      others: true,
      addable: 0,
    });
    ctx.raw.exec(`DELETE FROM meeting_shares; DELETE FROM users WHERE id != 'owner'`);
    expect(await findColleagues('meet-1', '')).toEqual({
      ok: true,
      colleagues: [],
      others: false,
      addable: 0,
    });
  });
});
