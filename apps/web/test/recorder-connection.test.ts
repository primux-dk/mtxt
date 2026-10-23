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
vi.mock('@/lib/install', () => ({
  getAdapters: async () => ({ db: state.db, installId: INSTALL }),
}));

const { getApiUser } = await import('../lib/auth/session');
const { pollForToken } = await import('../lib/recorders/token-poll');
const { connectParams, connectState } = await import('../lib/recorders/connect');

const settings = { installId: INSTALL, ...DEFAULT_SETTINGS, productName: 'Primux Møder' };
const verifier = 'v'.repeat(43);

describe('recorder connection', () => {
  let ctx: Awaited<ReturnType<typeof testDb>>;
  let challenge: string;
  const poll = async (body: unknown) => {
    const response = await pollForToken({ db: ctx.db, installId: INSTALL, settings }, body);
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

      // At once again: one poll a second. Later: used, 410.
      const again = await poll({ challenge, verifier });
      expect(again.status).toBe(429);
      expect(again.body).toEqual({
        error: { code: 'rate_limited', message: expect.any(String) },
        retry_after: 1,
      });
      expect(again.headers.get('retry-after')).toBe('1');
      ctx.raw.exec('update recorder_grants set last_poll_at = last_poll_at - 1000');
      const used = await poll({ challenge, verifier });
      expect(used.status).toBe(410);
      expect(used.body.error.code).toBe('expired');
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
