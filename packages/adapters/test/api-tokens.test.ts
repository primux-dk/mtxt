import { describe, expect, it } from 'vitest';
import { audit } from '../src/db/audit';
import { createApiToken, listApiTokens, takeApiRequest } from '../src/db/api-tokens';
import {
  findRecorderUser,
  listRecorderTokens,
  pruneRecorderRows,
  revokeRecorderToken,
  revokeToken,
} from '../src/db/recorders';
import {
  API_RATE_LIMIT,
  API_RATE_WINDOW_MS,
  hashRecorderToken,
  MAX_API_TOKENS,
  newRecorderToken,
  rateAllowed,
  TOKEN_KEEP_MS,
} from '../src/recorder-auth';
import { DAY, fixtures, INSTALL, rows, testDb } from './sqlite';

const T = Date.UTC(2026, 9, 23, 9);
const at = (ms: number) => new Date(T + ms);
const YEAR = 365 * DAY;

function setup() {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  f.user('mette', 'Mette Lund');
  f.user('anne', 'Anne Holm');
  return { db, sqlite, f };
}

async function make(
  db: ReturnType<typeof setup>['db'],
  input: { userId?: string; name?: string; scope?: 'read' | 'read_write'; now?: Date } = {},
) {
  const token = newRecorderToken();
  const result = await createApiToken(db, INSTALL, {
    userId: input.userId ?? 'mette',
    name: input.name ?? 'Alex',
    scope: input.scope ?? 'read',
    tokenHash: await hashRecorderToken(token),
    expiresAt: new Date((input.now ?? at(0)).getTime() + YEAR),
    now: input.now ?? at(0),
  });
  return { token, result };
}

describe('API tokens', () => {
  it('are stored as a hash with kind api, name and scope, and audited as created', async () => {
    const { db, sqlite } = setup();
    const { token, result } = await make(db, { scope: 'read_write' });
    expect(result.ok).toBe(true);
    const [row] = rows<Record<string, unknown>>(sqlite, 'select * from recorder_tokens');
    expect(row).toMatchObject({
      kind: 'api',
      scope: 'read_write',
      device_name: 'Alex',
      token_hash: await hashRecorderToken(token),
      user_id: 'mette',
    });
    expect(JSON.stringify(row)).not.toContain(token);
    const events = rows<{ action: string; details: string; user_id: string }>(
      sqlite,
      'select action, details, user_id from audit_events',
    );
    expect(events).toEqual([
      {
        action: 'api_token_created',
        details: '{"name":"Alex","scope":"read_write"}',
        user_id: 'mette',
      },
    ]);
  });

  it('resolve to their user with kind and scope, like a recorder token', async () => {
    const { db } = setup();
    const { token } = await make(db, { scope: 'read' });
    const found = await findRecorderUser(db, INSTALL, await hashRecorderToken(token), at(1000));
    expect(found).toMatchObject({ kind: 'api', scope: 'read', name: 'Alex' });
    expect(found?.user.id).toBe('mette');
  });

  it('stop at 25 working tokens per user, inside the insert, without an audit row', async () => {
    const { db, sqlite } = setup();
    for (let i = 0; i < MAX_API_TOKENS; i++) {
      expect((await make(db, { name: `T${i}` })).result.ok).toBe(true);
    }
    expect((await make(db, { name: 'one too many' })).result).toEqual({
      ok: false,
      reason: 'too_many',
    });
    expect(rows(sqlite, `select id from recorder_tokens where kind = 'api'`)).toHaveLength(25);
    expect(
      rows(sqlite, `select id from audit_events where action = 'api_token_created'`),
    ).toHaveLength(25);
    // Another user has room of their own; a revoked token frees a place.
    expect((await make(db, { userId: 'anne' })).result.ok).toBe(true);
    const [first] = await listApiTokens(db, INSTALL, 'mette', at(1));
    await revokeToken(db, INSTALL, { userId: 'mette', tokenId: first!.id, kind: 'api' });
    expect((await make(db, { name: 'now fits' })).result.ok).toBe(true);
  });

  it('are listed apart from recorders, and each list revokes only its own kind', async () => {
    const { db, sqlite } = setup();
    const { result } = await make(db);
    const id = result.ok ? result.id : '';
    sqlite.exec(`insert into recorder_tokens (id, install_id, user_id, device_name, token_hash, created_at, expires_at)
      values ('rec', '${INSTALL}', 'mette', 'Mac', 'h', ${T}, ${T + YEAR})`);
    expect((await listApiTokens(db, INSTALL, 'mette', at(1))).map((t) => t.id)).toEqual([id]);
    expect((await listRecorderTokens(db, INSTALL, 'mette', at(1))).map((t) => t.id)).toEqual([
      'rec',
    ]);
    // The Recorders dialog cannot revoke an API token, and the API tokens dialog no recorder.
    expect(await revokeRecorderToken(db, INSTALL, { userId: 'mette', tokenId: id })).toBe(
      'not_found',
    );
    expect(await revokeToken(db, INSTALL, { userId: 'mette', tokenId: 'rec', kind: 'api' })).toBe(
      'not_found',
    );
    // Another user's token is not found either.
    expect(await revokeToken(db, INSTALL, { userId: 'anne', tokenId: id, kind: 'api' })).toBe(
      'not_found',
    );
    expect(
      await revokeToken(db, INSTALL, { userId: 'mette', tokenId: id, kind: 'api', now: at(5) }),
    ).toBe('revoked');
    expect(await revokeToken(db, INSTALL, { userId: 'mette', tokenId: id, kind: 'api' })).toBe(
      'already',
    );
    expect(
      rows(sqlite, `select action, details from audit_events where action = 'api_token_revoked'`),
    ).toEqual([{ action: 'api_token_revoked', details: '{"name":"Alex","scope":"read"}' }]);
  });

  it('stop working when revoked or expired, and the nightly job prunes them like recorders', async () => {
    const { db } = setup();
    const { token, result } = await make(db);
    const hash = await hashRecorderToken(token);
    expect(await findRecorderUser(db, INSTALL, hash, at(YEAR - 1))).not.toBeNull();
    expect(await findRecorderUser(db, INSTALL, hash, at(YEAR))).toBeNull();
    await revokeToken(db, INSTALL, {
      userId: 'mette',
      tokenId: result.ok ? result.id : '',
      kind: 'api',
      now: at(1),
    });
    expect(await findRecorderUser(db, INSTALL, hash, at(2))).toBeNull();
    expect(await pruneRecorderRows(db, INSTALL, at(TOKEN_KEEP_MS + 2))).toEqual({
      grants: 0,
      tokens: 1,
    });
  });
});

describe('the API rate limit', () => {
  it('lets 60 requests through in a minute, then says how long to wait', async () => {
    const { db } = setup();
    const { result } = await make(db);
    const id = result.ok ? result.id : '';
    for (let i = 0; i < API_RATE_LIMIT; i++) {
      const taken = await takeApiRequest(db, INSTALL, id, at(i * 100));
      expect(taken).toEqual({ ok: true, remaining: API_RATE_LIMIT - 1 - i });
    }
    expect(await takeApiRequest(db, INSTALL, id, at(10_000))).toEqual({
      ok: false,
      retryAfter: 50,
      remaining: 0,
    });
    expect(await takeApiRequest(db, INSTALL, id, at(API_RATE_WINDOW_MS - 1))).toEqual({
      ok: false,
      retryAfter: 1,
      remaining: 0,
    });
    // A new minute starts a new window.
    expect(await takeApiRequest(db, INSTALL, id, at(API_RATE_WINDOW_MS))).toEqual({
      ok: true,
      remaining: API_RATE_LIMIT - 1,
    });
  });

  it('counts per token', async () => {
    const { db } = setup();
    const a = (await make(db, { name: 'A' })).result;
    const b = (await make(db, { name: 'B' })).result;
    for (let i = 0; i < API_RATE_LIMIT; i++) {
      await takeApiRequest(db, INSTALL, a.ok ? a.id : '', at(0));
    }
    expect((await takeApiRequest(db, INSTALL, a.ok ? a.id : '', at(1))).ok).toBe(false);
    expect((await takeApiRequest(db, INSTALL, b.ok ? b.id : '', at(1))).ok).toBe(true);
  });

  it('rateAllowed is the same rule, pure', () => {
    expect(rateAllowed({ at: null, count: 0 }, T)).toEqual({
      ok: true,
      fresh: true,
      remaining: 59,
    });
    expect(rateAllowed({ at: T, count: 59 }, T + 1)).toEqual({
      ok: true,
      fresh: false,
      remaining: 0,
    });
    expect(rateAllowed({ at: T, count: 60 }, T + 1)).toEqual({ ok: false, retryAfter: 60 });
    expect(rateAllowed({ at: T, count: 60 }, T + 59_001)).toEqual({ ok: false, retryAfter: 1 });
    expect(rateAllowed({ at: T, count: 60 }, T + 60_000)).toMatchObject({ ok: true, fresh: true });
  });
});

describe('opened through the API', () => {
  it('is deduplicated apart from the page, so neither hides the other', async () => {
    const { db, sqlite, f } = setup();
    f.meeting('m1', { owner: 'mette' });
    const opened = (details?: { via: 'api'; token: string }, ms = 0) =>
      audit(db, INSTALL, {
        userId: 'anne',
        meetingId: 'm1',
        meetingTitle: 'M',
        action: 'opened',
        details,
        at: at(ms),
      });
    expect(await opened()).toBe(true);
    expect(await opened({ via: 'api', token: 'Alex' }, 1)).toBe(true);
    expect(await opened({ via: 'api', token: 'Alex' }, 2)).toBe(false);
    expect(await opened(undefined, 3)).toBe(false);
    expect(rows(sqlite, `select details from audit_events order by at`)).toEqual([
      { details: null },
      { details: '{"via":"api","token":"Alex"}' },
    ]);
  });
});
