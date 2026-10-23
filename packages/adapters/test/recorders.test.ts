import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approveGrant,
  denyGrant,
  findRecorderUser,
  listRecorderTokens,
  pollGrant,
  revokeRecorderToken,
} from '../src/db/recorders';
import {
  bearerToken,
  cleanDeviceName,
  GRANT_LIFETIME_MS,
  hashRecorderToken,
  LAST_USED_EVERY_MS,
  MAX_PENDING_GRANTS,
  newRecorderToken,
  PAIRING_ALPHABET,
  pairingCode,
  pollAllowed,
  RECORDER_TOKEN_PATTERN,
  s256,
  safeEqual,
  TOKEN_LIFETIME_MS,
  verifierMatches,
} from '../src/recorder-auth';
import { DAY, fixtures, INSTALL, rows, testDb } from './sqlite';

const T = Date.UTC(2026, 9, 23, 9);
const at = (ms: number) => new Date(T + ms);

function setup() {
  const { db, sqlite, statements } = testDb();
  const f = fixtures(sqlite);
  f.user('mette', 'Mette Lund');
  f.user('anne', 'Anne Holm');
  return { db, sqlite, statements };
}

/** A verifier and its challenge, as a recorder makes them. */
async function pair(seed = 'a') {
  const verifier = seed.repeat(43).slice(0, 43);
  return { verifier, challenge: await s256(verifier) };
}

describe('recorder tokens', () => {
  it('are mtxt_ and 32 random bytes in base64url, and differ every time', () => {
    const a = newRecorderToken();
    expect(a).toMatch(RECORDER_TOKEN_PATTERN);
    expect(a).toHaveLength(48);
    expect(newRecorderToken()).not.toBe(a);
  });

  it('hash to the hex SHA-256 of the whole token', async () => {
    const token = newRecorderToken();
    expect(await hashRecorderToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('compare in constant time on equal lengths and refuse other lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('come out of a Bearer header only in their own shape', () => {
    const token = newRecorderToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    expect(bearerToken(`Basic ${token}`)).toBeNull();
    expect(bearerToken(`Bearer ${token}x`)).toBeNull();
    expect(bearerToken('Bearer eyJhbGciOi.x.y')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe('S256', () => {
  it('matches RFC 7636 appendix B', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('accepts the verifier that hashes to the challenge and nothing else', async () => {
    const { verifier, challenge } = await pair();
    expect(await verifierMatches(verifier, challenge)).toBe(true);
    expect(await verifierMatches('b'.repeat(43), challenge)).toBe(false);
    // Too short for RFC 7636, even when it would hash right.
    expect(await verifierMatches('short', await s256('short'))).toBe(false);
    expect(await verifierMatches(verifier, 'not a challenge')).toBe(false);
  });
});

describe('pairing code', () => {
  it('is six characters of the first 30 bits of SHA-256(challenge), as XXX-XXX', async () => {
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const bytes = createHash('sha256').update(challenge, 'ascii').digest();
    const bits = bytes.readUInt32BE(0) >>> 2;
    const expected = [25, 20, 15, 10, 5, 0]
      .map((s) => PAIRING_ALPHABET[(bits >>> s) & 31])
      .join('');
    const code = await pairingCode(challenge);
    expect(code).toBe(`${expected.slice(0, 3)}-${expected.slice(3)}`);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    // The contract's worked example.
    expect(code).toBe('1MM-SP7');
  });
});

describe('device names', () => {
  it('are trimmed, 1 to 64 characters, with no control characters', () => {
    expect(cleanDeviceName('  Mettes MacBook Pro ')).toBe('Mettes MacBook Pro');
    expect(cleanDeviceName('Ø'.repeat(64))).toBe('Ø'.repeat(64));
    expect(cleanDeviceName('Ø'.repeat(65))).toBeNull();
    expect(cleanDeviceName('')).toBeNull();
    expect(cleanDeviceName('Mac\nBook')).toBeNull();
    expect(cleanDeviceName('Mac\u202eBook')).toBeNull();
    expect(cleanDeviceName(null)).toBeNull();
  });
});

describe('pollAllowed', () => {
  it('lets one poll a second through and says how long to wait', () => {
    expect(pollAllowed(null, T)).toEqual({ ok: true });
    expect(pollAllowed(T, T + 1000)).toEqual({ ok: true });
    expect(pollAllowed(T, T + 999)).toEqual({ ok: false, retryAfter: 1 });
    expect(pollAllowed(T, T)).toEqual({ ok: false, retryAfter: 1 });
  });
});

describe('grants', () => {
  it('are pending until Approve, then make one token, once', async () => {
    const { db, sqlite } = setup();
    const { challenge } = await pair();
    const hash = await hashRecorderToken(newRecorderToken());
    expect(await pollGrant(db, INSTALL, { challenge, tokenHash: hash, now: at(0) })).toEqual({
      kind: 'pending',
    });
    // Nothing is written for a challenge with no grant.
    expect(rows(sqlite, 'select * from recorder_grants')).toHaveLength(0);

    expect(
      await approveGrant(db, INSTALL, {
        challenge,
        userId: 'mette',
        deviceName: 'Mac',
        now: at(0),
      }),
    ).toBe('approved');
    const result = await pollGrant(db, INSTALL, { challenge, tokenHash: hash, now: at(2000) });
    expect(result).toMatchObject({ kind: 'token', userId: 'mette', deviceName: 'Mac' });
    if (result.kind !== 'token') throw new Error();
    expect(result.expiresAt.getTime()).toBe(T + 2000 + TOKEN_LIFETIME_MS);

    const [token] = rows<{ id: string; token_hash: string; user_id: string }>(
      sqlite,
      'select id, token_hash, user_id from recorder_tokens',
    );
    expect(token).toEqual({ id: result.tokenId, token_hash: hash, user_id: 'mette' });
    expect(
      rows(
        sqlite,
        "select user_id, meeting_id, details from audit_events where action = 'recorder_connected'",
      ),
    ).toEqual([{ user_id: 'mette', meeting_id: null, details: '{"device":"Mac"}' }]);

    // Used: the next poll is 410, and no second token exists.
    expect(await pollGrant(db, INSTALL, { challenge, tokenHash: hash, now: at(4000) })).toEqual({
      kind: 'expired',
    });
    expect(rows(sqlite, 'select id from recorder_tokens')).toHaveLength(1);
  });

  it('expire 10 minutes after Approve', async () => {
    const { db, sqlite } = setup();
    const { challenge } = await pair();
    await approveGrant(db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac', now: at(0) });
    const late = await pollGrant(db, INSTALL, {
      challenge,
      tokenHash: 'h',
      now: at(GRANT_LIFETIME_MS),
    });
    expect(late).toEqual({ kind: 'expired' });
    expect(rows(sqlite, 'select id from recorder_tokens')).toHaveLength(0);
  });

  it('answer denied after Cancel, and a challenge is used once', async () => {
    const { db } = setup();
    const { challenge } = await pair();
    expect(
      await denyGrant(db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac', now: at(0) }),
    ).toBe('denied');
    expect(
      await approveGrant(db, INSTALL, {
        challenge,
        userId: 'mette',
        deviceName: 'Mac',
        now: at(1),
      }),
    ).toBe('exists');
    expect(await pollGrant(db, INSTALL, { challenge, tokenHash: 'h', now: at(10) })).toEqual({
      kind: 'denied',
    });
  });

  it('let one poll a second through per approved grant', async () => {
    const { db, sqlite } = setup();
    const { challenge } = await pair();
    await approveGrant(db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac', now: at(0) });
    sqlite.exec(`update recorder_grants set last_poll_at = ${T + 100}`);
    expect(await pollGrant(db, INSTALL, { challenge, tokenHash: 'h', now: at(500) })).toEqual({
      kind: 'rate_limited',
      retryAfter: 1,
    });
    expect(rows(sqlite, 'select id from recorder_tokens')).toHaveLength(0);
    expect(
      await pollGrant(db, INSTALL, { challenge, tokenHash: 'h', now: at(1100) }),
    ).toMatchObject({
      kind: 'token',
    });
  });

  it('cost one read for no grant, a denied grant and a used grant; write only for an approved one', async () => {
    const { db, statements } = setup();
    const { challenge } = await pair();
    const count = async (now: number) => {
      statements.length = 0;
      const result = await pollGrant(db, INSTALL, { challenge, tokenHash: 'h', now: at(now) });
      return { kind: result.kind, statements: [...statements] };
    };
    const unknown = await count(0);
    expect(unknown.kind).toBe('pending');
    expect(unknown.statements).toHaveLength(1);
    expect(unknown.statements[0]).toMatch(/^select /);
    // Steady state: polling again stays one read each time.
    expect((await count(10)).statements).toHaveLength(1);

    await approveGrant(db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac', now: at(20) });
    const issued = await count(30);
    expect(issued.kind).toBe('token');
    expect(issued.statements.filter((q) => /^(update|insert)/.test(q))).toHaveLength(4);

    const used = await count(5000);
    expect(used).toEqual({ kind: 'expired', statements: [expect.stringMatching(/^select /)] });

    const other = await pair('d');
    await denyGrant(db, INSTALL, {
      challenge: other.challenge,
      userId: 'mette',
      deviceName: 'Mac',
      now: at(0),
    });
    statements.length = 0;
    expect(
      (await pollGrant(db, INSTALL, { challenge: other.challenge, tokenHash: 'h', now: at(10) }))
        .kind,
    ).toBe('denied');
    expect(statements).toHaveLength(1);
  });

  it('hold at most 20 pending per user, and forget the expired ones', async () => {
    const { db, sqlite } = setup();
    for (let i = 0; i < MAX_PENDING_GRANTS; i++) {
      const { challenge } = await pair(String.fromCharCode(97 + i));
      expect(
        await approveGrant(db, INSTALL, {
          challenge,
          userId: 'mette',
          deviceName: 'D',
          now: at(i),
        }),
      ).toBe('approved');
    }
    const extra = await pair('z');
    expect(
      await approveGrant(db, INSTALL, {
        challenge: extra.challenge,
        userId: 'mette',
        deviceName: 'D',
        now: at(100),
      }),
    ).toBe('too_many');
    // Another user is not held by Mette's count.
    expect(
      await approveGrant(db, INSTALL, {
        challenge: extra.challenge,
        userId: 'anne',
        deviceName: 'D',
        now: at(100),
      }),
    ).toBe('approved');
    // Once they expire, Mette may approve again; a day later the old rows are gone.
    const later = await pair('y');
    expect(
      await approveGrant(db, INSTALL, {
        challenge: later.challenge,
        userId: 'mette',
        deviceName: 'D',
        now: at(GRANT_LIFETIME_MS + DAY + 100),
      }),
    ).toBe('approved');
    expect(
      rows(sqlite, "select challenge from recorder_grants where user_id = 'mette'"),
    ).toHaveLength(1);
  });

  it('are scoped to their install', async () => {
    const { db } = setup();
    const { challenge } = await pair();
    await approveGrant(db, INSTALL, { challenge, userId: 'mette', deviceName: 'Mac', now: at(0) });
    expect(await pollGrant(db, 'other', { challenge, tokenHash: 'h', now: at(10) })).toEqual({
      kind: 'pending',
    });
  });
});

describe('bearer resolution', () => {
  async function connected() {
    const ctx = setup();
    const { challenge } = await pair();
    const token = newRecorderToken();
    const hash = await hashRecorderToken(token);
    await approveGrant(ctx.db, INSTALL, {
      challenge,
      userId: 'mette',
      deviceName: 'Mac',
      now: at(0),
    });
    const result = await pollGrant(ctx.db, INSTALL, { challenge, tokenHash: hash, now: at(10) });
    if (result.kind !== 'token') throw new Error(result.kind);
    return { ...ctx, hash, tokenId: result.tokenId };
  }

  it('resolves a working token to its user row and writes last_used_at at most every 5 minutes', async () => {
    const { db, sqlite, hash } = await connected();
    const found = await findRecorderUser(db, INSTALL, hash, at(1000));
    expect(found?.user).toMatchObject({ id: 'mette', name: 'Mette Lund' });
    const used = () =>
      rows<{ last_used_at: number }>(sqlite, 'select last_used_at from recorder_tokens')[0]!
        .last_used_at;
    expect(used()).toBe(T + 1000);
    await findRecorderUser(db, INSTALL, hash, at(1000 + LAST_USED_EVERY_MS - 1));
    expect(used()).toBe(T + 1000);
    await findRecorderUser(db, INSTALL, hash, at(1000 + LAST_USED_EVERY_MS + 1));
    expect(used()).toBe(T + 1000 + LAST_USED_EVERY_MS + 1);
  });

  it('refuses an unknown, revoked or expired token, and one in another install', async () => {
    const { db, hash, tokenId } = await connected();
    expect(
      await findRecorderUser(db, INSTALL, await hashRecorderToken(newRecorderToken()), at(1)),
    ).toBeNull();
    expect(await findRecorderUser(db, 'other', hash, at(1))).toBeNull();
    expect(await findRecorderUser(db, INSTALL, hash, at(10 + TOKEN_LIFETIME_MS))).toBeNull();
    expect(
      await findRecorderUser(db, INSTALL, hash, at(10 + TOKEN_LIFETIME_MS - 1)),
    ).not.toBeNull();
    expect(await revokeRecorderToken(db, INSTALL, { userId: 'mette', tokenId, now: at(20) })).toBe(
      'revoked',
    );
    expect(await findRecorderUser(db, INSTALL, hash, at(30))).toBeNull();
  });

  it('follows the user row: a token whose user is gone stands for nobody', async () => {
    const { db, sqlite, hash } = await connected();
    sqlite.exec('PRAGMA foreign_keys = OFF');
    sqlite.exec("delete from users where id = 'mette'");
    expect(await findRecorderUser(db, INSTALL, hash, at(1))).toBeNull();
  });
});

describe('Recorders list and Disconnect', () => {
  it('lists working tokens newest first; Disconnect is the owner’s, once, with an audit row', async () => {
    const { db, sqlite } = setup();
    const ids: string[] = [];
    for (const [i, seed] of ['a', 'b', 'c'].entries()) {
      const { challenge } = await pair(seed);
      await approveGrant(db, INSTALL, {
        challenge,
        userId: 'mette',
        deviceName: `D${i}`,
        now: at(i),
      });
      const r = await pollGrant(db, INSTALL, { challenge, tokenHash: `h${i}`, now: at(10 + i) });
      if (r.kind === 'token') ids.push(r.tokenId);
    }
    expect(
      (await listRecorderTokens(db, INSTALL, 'mette', at(100))).map((t) => t.deviceName),
    ).toEqual(['D2', 'D1', 'D0']);
    expect(
      await revokeRecorderToken(db, INSTALL, { userId: 'anne', tokenId: ids[0]!, now: at(200) }),
    ).toBe('not_found');
    expect(
      await revokeRecorderToken(db, INSTALL, { userId: 'mette', tokenId: ids[0]!, now: at(200) }),
    ).toBe('revoked');
    expect(
      await revokeRecorderToken(db, INSTALL, { userId: 'mette', tokenId: ids[0]!, now: at(300) }),
    ).toBe('already');
    expect(
      (await listRecorderTokens(db, INSTALL, 'mette', at(400))).map((t) => t.deviceName),
    ).toEqual(['D2', 'D1']);
    expect(
      rows(
        sqlite,
        "select user_id, details from audit_events where action = 'recorder_disconnected'",
      ),
    ).toEqual([{ user_id: 'mette', details: '{"device":"D0"}' }]);
    // Expired tokens leave the list.
    expect(await listRecorderTokens(db, INSTALL, 'mette', at(20 + TOKEN_LIFETIME_MS))).toEqual([]);
  });
});
