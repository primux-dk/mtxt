import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

/*
  The speaker actions as a reader, a stranger and the owner (behaviour.md
  rule 4: only the owner renames or links). The session and the adapters
  are mocked; the permission check and the database are real.
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

const { updateSpeaker, searchColleagues } = await import('../app/(app)/meetings/speaker-actions');

describe('speaker actions', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  const as = (id: string, isAdmin = false) =>
    (state.user = { id, email: `${id}@example.com`, name: id, isAdmin });
  const label = () =>
    ctx.raw.prepare(`select label, user_id from speakers where id = 's1'`).get() as {
      label: string;
      user_id: string | null;
    };

  beforeEach(async () => {
    ctx = await testDb();
    state.db = ctx.db;
    seedRecording(ctx.raw);
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES
        ('reader', '${INSTALL}', 'r', 'reader@example.com', 'Anne Holm', 0),
        ('admin', '${INSTALL}', 'a', 'admin@example.com', 'Søren Bak', 1);
      UPDATE meetings SET visibility = 'company';
      INSERT INTO speakers (id, install_id, meeting_id, label, speaker_index)
        VALUES ('s1', '${INSTALL}', 'meet-1', 'Speaker 1', 0);`);
  });

  it('refuses a reader rename with forbidden and changes nothing', async () => {
    as('reader');
    expect(await updateSpeaker('meet-1', 's1', { label: 'Hacked', userId: null })).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(label()).toEqual({ label: 'Speaker 1', user_id: null });
  });

  it('refuses a reader link with forbidden, an admin included', async () => {
    for (const who of ['reader', 'admin']) {
      as(who, who === 'admin');
      expect(await updateSpeaker('meet-1', 's1', { label: 'Anne Holm', userId: 'reader' })).toEqual(
        {
          ok: false,
          code: 'forbidden',
        },
      );
      expect(await searchColleagues('meet-1', 'anne')).toBeNull();
    }
    expect(label()).toEqual({ label: 'Speaker 1', user_id: null });
  });

  it('refuses a signed-out caller and a private meeting the caller cannot read', async () => {
    state.user = null;
    expect(await updateSpeaker('meet-1', 's1', { label: 'X', userId: null })).toMatchObject({
      code: 'forbidden',
    });
    ctx.raw.exec(`UPDATE meetings SET visibility = 'private'`);
    as('reader');
    expect(await updateSpeaker('meet-1', 's1', { label: 'X', userId: null })).toMatchObject({
      code: 'forbidden',
    });
  });

  it('lets the owner rename, link and unlink', async () => {
    as('owner');
    expect(await updateSpeaker('meet-1', 's1', { label: 'Anne Holm', userId: 'reader' })).toEqual({
      ok: true,
    });
    expect(label()).toEqual({ label: 'Anne Holm', user_id: 'reader' });
    expect((await searchColleagues('meet-1', 'ANNE'))?.map((c) => c.id)).toEqual(['reader']);
    expect(await updateSpeaker('meet-1', 's1', { label: 'Anne Holm', userId: null })).toEqual({
      ok: true,
    });
    expect(label()).toEqual({ label: 'Anne Holm', user_id: null });
    expect(await updateSpeaker('meet-1', 's1', { label: 'x', userId: 'nobody' })).toEqual({
      ok: false,
      code: 'invalid',
    });
  });
});
