import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveGrant,
  denyGrant,
  DEFAULT_SETTINGS,
  hashRecorderToken,
  revokeRecorderToken,
  s256,
  TOKEN_LIFETIME_MS,
} from '@mtxt/adapters';
import { INSTALL, testDb } from './sqlite-db';

/*
  The recorder connection on the web side: the token poll's answers, and
  bearer resolution next to the session cookie (docs/spec.md "Recorder
  connection"). The request headers, the session and the adapters are
  mocked; the database and the token logic are real.
*/
const state = vi.hoisted(() => ({
  headers: new Headers(),
  sessionUserId: null as string | null,
  db: null as unknown,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => state.headers }));
vi.mock('@/lib/auth', () => ({
  auth: async () => (state.sessionUserId ? { user: { id: state.sessionUserId } } : null),
}));
const loads = vi.hoisted(() => ({ adapters: 0, settings: 0 }));
vi.mock('@/lib/install', () => ({
  getAdapters: async () => {
    loads.adapters++;
    return { db: state.db, installId: INSTALL };
  },
}));

const { getApiUser } = await import('../lib/auth/session');
const { pollForToken } = await import('../lib/recorders/token-poll');
const { connectParams, connectState } = await import('../lib/recorders/connect');
const { DELETE } = await import('../app/api/v1/recorder/tokens/[id]/route');

const settings = { installId: INSTALL, ...DEFAULT_SETTINGS, productName: 'Primux Møder' };
const verifier = 'v'.repeat(43);

describe('recorder connection', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  let challenge: string;
  const poll = async (body: unknown) => {
    const response = await pollForToken(
      {
        adapters: async () => {
          loads.adapters++;
          return { db: ctx.db, installId: INSTALL };
        },
        settings: async () => {
          loads.settings++;
          return settings;
        },
      },
      body,
    );
    return {
      status: response.status,
      headers: response.headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as any,
    };
  };

  beforeEach(async () => {
    ctx = await testDb();
    state.db = ctx.db;
    state.headers = new Headers();
    state.sessionUserId = null;
    loads.adapters = 0;
    loads.settings = 0;
    challenge = await s256(verifier);
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES
      ('mette', '${INSTALL}', 'm', 'mette@example.com', 'Mette Lund', 1),
      ('anne', '${INSTALL}', 'a', 'anne@example.com', 'Anne Holm', 0)`);
  });

  describe('the token poll', () => {
    it('refuses a body without a well-formed challenge and verifier', async () => {
      for (const body of [null, {}, { challenge }, { challenge, verifier: 'short' }, 'x']) {
        const r = await poll(body);
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('invalid_request');
      }
      // Refused before the database is asked.
      expect(loads.adapters).toBe(0);
    });

    it('answers a wrong verifier without the database, and loads the settings only to issue a token', async () => {
      expect((await poll({ challenge, verifier: 'w'.repeat(43) })).status).toBe(410);
      expect(loads).toEqual({ adapters: 0, settings: 0 });
      expect((await poll({ challenge, verifier })).status).toBe(202);
      expect(loads).toEqual({ adapters: 1, settings: 0 });
      await approveGrant(ctx.db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac' });
      expect((await poll({ challenge, verifier })).status).toBe(200);
      expect(loads.settings).toBe(1);
    });

    it('answers 202 with Retry-After until Approve, and writes nothing', async () => {
      const r = await poll({ challenge, verifier });
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ status: 'pending' });
      expect(r.headers.get('retry-after')).toBe('2');
      expect(ctx.raw.prepare('select count(*) as n from recorder_grants').get()).toEqual({ n: 0 });
    });

    it('answers 410 denied to a verifier that does not hash to the challenge, approved or not', async () => {
      await approveGrant(ctx.db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac' });
      const r = await poll({ challenge, verifier: 'w'.repeat(43) });
      expect(r.status).toBe(410);
      expect(r.body.error.code).toBe('denied');
      // The grant is untouched: the right verifier still gets the token.
      expect((await poll({ challenge, verifier })).status).toBe(200);
    });

    it('sends the token once, with the branding, and keeps only its hash', async () => {
      await approveGrant(ctx.db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mettes Mac' });
      const r = await poll({ challenge, verifier });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        token: expect.stringMatching(/^mtxt_[A-Za-z0-9_-]{43}$/),
        token_id: expect.any(String),
        expires_at: expect.any(String),
        device_name: 'Mettes Mac',
        user: { name: 'Mette Lund' },
        install: {
          product_name: 'Primux Møder',
          theme_accent: '#566b45',
          theme_primary: '#111111',
        },
      });
      const lifetime = Date.parse(r.body.expires_at) - Date.now();
      expect(Math.abs(lifetime - TOKEN_LIFETIME_MS)).toBeLessThan(60_000);
      const stored = ctx.raw.prepare('select * from recorder_tokens').all();
      expect(stored).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(r.body.token);
      expect(stored[0]).toMatchObject({ token_hash: await hashRecorderToken(r.body.token) });

      // Used: the next poll is 410 at once, and writes nothing.
      const used = await poll({ challenge, verifier });
      expect(used.status).toBe(410);
      expect(used.body.error.code).toBe('expired');
    });

    it('answers 429 with Retry-After to a second poll inside a second on an approved grant', async () => {
      await approveGrant(ctx.db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac' });
      ctx.raw.exec(`update recorder_grants set last_poll_at = ${Date.now()}`);
      const fast = await poll({ challenge, verifier });
      expect(fast.status).toBe(429);
      expect(fast.body).toEqual({
        error: { code: 'rate_limited', message: expect.any(String) },
        retry_after: 1,
      });
      expect(fast.headers.get('retry-after')).toBe('1');
      expect(ctx.raw.prepare('select count(*) as n from recorder_tokens').get()).toEqual({ n: 0 });
    });

    it('answers 410 denied after Cancel and 410 expired after 10 minutes', async () => {
      await denyGrant(ctx.db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac' });
      expect((await poll({ challenge, verifier })).body.error.code).toBe('denied');

      const other = 'o'.repeat(43);
      await approveGrant(ctx.db, INSTALL, {
        challenge: await s256(other),
        userId: 'mette',
        deviceName: 'Mac',
        now: new Date(Date.now() - 11 * 60 * 1000),
      });
      const late = await poll({ challenge: await s256(other), verifier: other });
      expect(late.status).toBe(410);
      expect(late.body.error.code).toBe('expired');
    });
  });

  describe('getApiUser', () => {
    async function connect(userId = 'mette') {
      await approveGrant(ctx.db, INSTALL, { challenge, userId, deviceName: 'Mac' });
      const r = await poll({ challenge, verifier });
      return r.body as { token: string; token_id: string };
    }

    it('reads the session cookie when there is no Authorization header', async () => {
      state.sessionUserId = 'anne';
      expect(await getApiUser()).toMatchObject({ id: 'anne', isAdmin: false });
    });

    it('resolves a bearer token to its user row, which decides email and admin', async () => {
      const { token } = await connect();
      ctx.raw.exec(
        `update users set email = 'mette.lund@example.com', is_admin = 0 where id = 'mette'`,
      );
      state.headers = new Headers({ authorization: `Bearer ${token}` });
      expect(await getApiUser()).toEqual({
        id: 'mette',
        name: 'Mette Lund',
        email: 'mette.lund@example.com',
        isAdmin: false,
        recorderTokenId: expect.any(String),
      });
    });

    it('is no one for a revoked, expired, unknown or malformed token, whatever the cookie says', async () => {
      const { token, token_id } = await connect();
      state.sessionUserId = 'anne';
      for (const header of [`Bearer mtxt_${'x'.repeat(43)}`, 'Bearer nope', `Basic ${token}`]) {
        state.headers = new Headers({ authorization: header });
        expect(await getApiUser(), header).toBeNull();
      }
      ctx.raw.exec(`update recorder_tokens set expires_at = ${Date.now() - 1}`);
      state.headers = new Headers({ authorization: `Bearer ${token}` });
      expect(await getApiUser()).toBeNull();

      ctx.raw.exec(`update recorder_tokens set expires_at = ${Date.now() + 60_000}`);
      expect(await getApiUser()).toMatchObject({ id: 'mette' });
      await revokeRecorderToken(ctx.db, INSTALL, { userId: 'mette', tokenId: token_id });
      expect(await getApiUser()).toBeNull();
    });
  });

  describe('DELETE /api/v1/recorder/tokens/{id}', () => {
    async function connectTwo() {
      const ids: { token: string; token_id: string }[] = [];
      for (const seed of ['p', 'q']) {
        const v = seed.repeat(43);
        const c = await s256(v);
        await approveGrant(ctx.db, INSTALL, { challenge: c, userId: 'mette', deviceName: seed });
        ids.push((await poll({ challenge: c, verifier: v })).body);
      }
      return ids;
    }
    const del = async (id: string) =>
      (await DELETE(new Request('http://x'), { params: Promise.resolve({ id }) })).status;

    it('with a bearer token revokes only that token: a sibling is 404 and stays connected', async () => {
      const [a, b] = await connectTwo();
      state.headers = new Headers({ authorization: `Bearer ${a!.token}` });
      expect(await del(b!.token_id)).toBe(404);
      expect(
        ctx.raw.prepare('select revoked_at from recorder_tokens where id = ?').get(b!.token_id),
      ).toEqual({ revoked_at: null });
      expect(await del(a!.token_id)).toBe(204);
    });

    it('with the session cookie revokes any of the user’s own tokens, never another user’s', async () => {
      const [a, b] = await connectTwo();
      state.sessionUserId = 'anne';
      expect(await del(a!.token_id)).toBe(404);
      state.sessionUserId = 'mette';
      expect(await del(a!.token_id)).toBe(204);
      expect(await del(b!.token_id)).toBe(204);
      expect(await del(b!.token_id)).toBe(204);
    });
  });

  describe('the connect page', () => {
    it('takes a 43-character challenge and a device name of 1 to 64 characters', () => {
      expect(connectParams(challenge, ' Mac ')).toEqual({ challenge, deviceName: 'Mac' });
      expect(connectParams(challenge, 'Æ'.repeat(64))?.deviceName).toHaveLength(64);
      expect(connectParams(challenge, 'Æ'.repeat(65))).toBeNull();
      expect(connectParams('short', 'Mac')).toBeNull();
      expect(connectParams(challenge, '')).toBeNull();
      expect(connectParams(undefined, undefined)).toBeNull();
    });

    it('asks once, then shows what the grant says; another user’s grant reads as expired', () => {
      const now = new Date();
      const later = new Date(now.getTime() + 60_000);
      const grant = (status: 'approved' | 'denied' | 'redeemed', userId = 'mette') => ({
        status,
        userId,
        expiresAt: later,
      });
      expect(connectState(undefined, 'mette', now)).toBe('ask');
      expect(connectState(grant('approved'), 'mette', now)).toBe('approved');
      expect(connectState(grant('approved'), 'mette', new Date(later.getTime() + 1))).toBe(
        'expired',
      );
      expect(connectState(grant('redeemed'), 'mette', now)).toBe('connected');
      expect(connectState(grant('denied'), 'mette', now)).toBe('denied');
      expect(connectState(grant('approved', 'anne'), 'mette', now)).toBe('expired');
    });
  });
});
