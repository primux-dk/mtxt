import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import {
  GRANT_KEEP_MS,
  GRANT_LIFETIME_MS,
  LAST_USED_EVERY_MS,
  MAX_PENDING_GRANTS,
  POLL_INTERVAL_MS,
  pollAllowed,
  safeEqual,
  TOKEN_KEEP_MS,
  TOKEN_LIFETIME_MS,
} from '../recorder-auth';
import type { Db } from './index';
import {
  auditEvents,
  recorderGrants,
  recorderTokens,
  users,
  type RecorderGrant,
  type TokenKind,
} from './schema';
import { findUser } from './users';

/*
  The recorder connection's rows (docs/spec.md "Recorder connection").
  A grant is written by Approve or Cancel on /connect, never by a caller
  without a session; the recorder's poll exchanges an approved grant for a
  token. Every statement carries install_id.
*/

const g = recorderGrants;
const tk = recorderTokens;

/** A bound value selected under a column's name, for INSERT ... SELECT in the table's column order. */
const value = <T>(v: T, column: string) => sql<T>`${v}`.as(column);

export interface GrantInput {
  challenge: string;
  userId: string;
  deviceName: string;
  now?: Date;
}

const forgetOldGrants = (db: Db, installId: string, userId: string, now: number) =>
  db
    .delete(g)
    .where(
      and(
        eq(g.installId, installId),
        eq(g.userId, userId),
        sql`${g.expiresAt} < ${now - GRANT_KEEP_MS}`,
      ),
    );

/** The grant for a challenge, whoever holds it. */
export const findGrant = (db: Db, installId: string, challenge: string) =>
  db.query.recorderGrants.findFirst({
    where: and(eq(g.installId, installId), eq(g.challenge, challenge)),
  }) as Promise<RecorderGrant | undefined>;

/**
 * Approve on /connect: an approved grant for 10 minutes. A challenge is used
 * once, so an existing grant is left as it is (`exists`). The 21st pending
 * grant of a user is refused inside the same statement (`too_many`).
 */
export async function approveGrant(
  db: Db,
  installId: string,
  input: GrantInput,
): Promise<'approved' | 'exists' | 'too_many'> {
  const now = (input.now ?? new Date()).getTime();
  await forgetOldGrants(db, installId, input.userId, now);
  const rows = await db.all<{ challenge: string }>(sql`
    insert into recorder_grants (install_id, challenge, user_id, device_name, status, created_at, expires_at)
    select ${installId}, ${input.challenge}, ${input.userId}, ${input.deviceName}, 'approved', ${now}, ${now + GRANT_LIFETIME_MS}
    where (
      select count(*) from recorder_grants
      where install_id = ${installId} and user_id = ${input.userId}
        and status = 'approved' and expires_at > ${now}
    ) < ${MAX_PENDING_GRANTS}
    on conflict (install_id, challenge) do nothing
    returning challenge`);
  if (rows.length) return 'approved';
  return (await findGrant(db, installId, input.challenge)) ? 'exists' : 'too_many';
}

/** Cancel on /connect: a denied grant, so the recorder's next poll gets 410 at once. */
export async function denyGrant(
  db: Db,
  installId: string,
  input: GrantInput,
): Promise<'denied' | 'exists'> {
  const now = (input.now ?? new Date()).getTime();
  await forgetOldGrants(db, installId, input.userId, now);
  const rows = await db.all<{ challenge: string }>(sql`
    insert into recorder_grants (install_id, challenge, user_id, device_name, status, created_at, expires_at)
    values (${installId}, ${input.challenge}, ${input.userId}, ${input.deviceName}, 'denied', ${now}, ${now + GRANT_LIFETIME_MS})
    on conflict (install_id, challenge) do nothing
    returning challenge`);
  return rows.length ? 'denied' : 'exists';
}

export type PollResult =
  /** No grant for the challenge yet: the user has not approved. */
  | { kind: 'pending' }
  | { kind: 'rate_limited'; retryAfter: number }
  /** Past its 10 minutes, or already exchanged for a token. */
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'token'; tokenId: string; userId: string; deviceName: string; expiresAt: Date };

/**
 * The recorder's poll, after the route has checked the verifier against the
 * challenge. The poll is open to anyone, so the common answers cost one read:
 * no grant (202), and a denied, used or expired grant (410). Only an approved
 * grant is written to: one conditional UPDATE lets one poll per second
 * through, then one batch makes the token row, the `recorder_connected`
 * audit row and marks the grant redeemed, each conditional on the grant
 * still being approved and unexpired, so two polls at once never make two
 * tokens.
 */
export async function pollGrant(
  db: Db,
  installId: string,
  input: { challenge: string; tokenHash: string; now?: Date },
): Promise<PollResult> {
  const now = (input.now ?? new Date()).getTime();
  const grant = await findGrant(db, installId, input.challenge);
  if (!grant) return { kind: 'pending' };
  if (grant.status === 'denied') return { kind: 'denied' };
  if (grant.status !== 'approved' || grant.expiresAt.getTime() <= now) return { kind: 'expired' };

  const mine = and(eq(g.installId, installId), eq(g.challenge, input.challenge));
  const passed = await db
    .update(g)
    .set({ lastPollAt: new Date(now) })
    .where(
      and(
        mine,
        eq(g.status, 'approved'),
        sql`(${g.lastPollAt} is null or ${g.lastPollAt} <= ${now - POLL_INTERVAL_MS})`,
      ),
    )
    .returning({ challenge: g.challenge });
  if (!passed.length) {
    const wait = pollAllowed(grant.lastPollAt?.getTime() ?? null, now);
    return { kind: 'rate_limited', retryAfter: wait.ok ? 1 : wait.retryAfter };
  }

  const live = and(mine, eq(g.status, 'approved'), gt(g.expiresAt, new Date(now)));
  const tokenId = crypto.randomUUID();
  const expiresAt = now + TOKEN_LIFETIME_MS;
  const [, , redeemed] = await db.batch([
    db.insert(tk).select(
      db
        .select({
          id: value(tokenId, 'id'),
          installId: g.installId,
          userId: g.userId,
          deviceName: g.deviceName,
          tokenHash: value(input.tokenHash, 'token_hash'),
          createdAt: value(now, 'created_at'),
          lastUsedAt: value(null, 'last_used_at'),
          expiresAt: value(expiresAt, 'expires_at'),
          revokedAt: value(null, 'revoked_at'),
          kind: value('recorder', 'kind'),
          scope: value(null, 'scope'),
          rateWindowAt: value(null, 'rate_window_at'),
          rateCount: value(0, 'rate_count'),
          clientId: value(null, 'client_id'),
          refreshHash: value(null, 'refresh_hash'),
          accessExpiresAt: value(null, 'access_expires_at'),
        })
        .from(g)
        .where(live),
    ),
    db.insert(auditEvents).select(
      db
        .select({
          id: value(crypto.randomUUID(), 'id'),
          installId: g.installId,
          userId: g.userId,
          meetingId: value(null, 'meeting_id'),
          meetingTitle: value(null, 'meeting_title'),
          action: value('recorder_connected', 'action'),
          details: sql<string>`json_object('device', ${g.deviceName})`.as('details'),
          at: value(now, 'at'),
        })
        .from(g)
        .where(live),
    ),
    db
      .update(g)
      .set({ status: 'redeemed', tokenId })
      .where(live)
      .returning({ userId: g.userId, deviceName: g.deviceName }),
  ]);
  const row = redeemed[0];
  // Another poll won the grant between the two statements.
  if (!row) return { kind: 'expired' };
  return {
    kind: 'token',
    tokenId,
    userId: row.userId,
    deviceName: row.deviceName,
    expiresAt: new Date(expiresAt),
  };
}

/**
 * The user a bearer token stands for, or null for a token that is unknown,
 * revoked, expired or whose user row is gone. The user row decides, as it
 * does for a session cookie. `last_used_at` is written at most once per
 * LAST_USED_EVERY_MS. Recorder and API tokens alike; `kind` says which, and
 * the caller decides what each may reach.
 */
export async function findRecorderUser(
  db: Db,
  installId: string,
  tokenHash: string,
  now: Date = new Date(),
) {
  const token = await db.query.recorderTokens.findFirst({
    where: and(eq(tk.installId, installId), eq(tk.tokenHash, tokenHash)),
  });
  if (!token || !safeEqual(token.tokenHash, tokenHash)) return null;
  if (token.revokedAt || token.expiresAt.getTime() <= now.getTime()) return null;
  // An MCP connection's access token lapses within the hour; its client refreshes it.
  if (token.accessExpiresAt && token.accessExpiresAt.getTime() <= now.getTime()) return null;
  const user = await findUser(db, installId, token.userId);
  if (!user) return null;
  const stale = now.getTime() - LAST_USED_EVERY_MS;
  if (!token.lastUsedAt || token.lastUsedAt.getTime() < stale) {
    await db
      .update(tk)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(tk.installId, installId),
          eq(tk.id, token.id),
          sql`(${tk.lastUsedAt} is null or ${tk.lastUsedAt} < ${stale})`,
        ),
      );
  }
  return {
    user,
    tokenId: token.id,
    kind: token.kind,
    scope: token.scope,
    /** The device name, or the API token's name. */
    name: token.deviceName,
  };
}

export interface RecorderConnection {
  id: string;
  deviceName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/** A user's working recorder tokens, newest first. Revoked and expired ones are left out. */
export async function listRecorderTokens(
  db: Db,
  installId: string,
  userId: string,
  now: Date = new Date(),
): Promise<RecorderConnection[]> {
  return db
    .select({
      id: tk.id,
      deviceName: tk.deviceName,
      createdAt: tk.createdAt,
      lastUsedAt: tk.lastUsedAt,
      expiresAt: tk.expiresAt,
    })
    .from(tk)
    .innerJoin(users, and(eq(users.id, tk.userId), eq(users.installId, installId)))
    .where(
      and(
        eq(tk.installId, installId),
        eq(tk.userId, userId),
        eq(tk.kind, 'recorder'),
        isNull(tk.revokedAt),
        gt(tk.expiresAt, now),
      ),
    )
    .orderBy(desc(tk.createdAt), tk.id)
    .limit(500);
}

/**
 * Disconnect: revokes one of the user's own recorder tokens and writes
 * `recorder_disconnected`, in one batch. Sets a value, so a retry is
 * `already` and writes nothing. Another user's token, or an API token, is
 * `not_found`.
 */
export const revokeRecorderToken = (
  db: Db,
  installId: string,
  input: { userId: string; tokenId: string; now?: Date },
) => revokeToken(db, installId, { ...input, kind: 'recorder' });

/**
 * Revokes one of the user's own tokens of one kind, with its audit row
 * (`recorder_disconnected` with the device, or `api_token_revoked` with the
 * token's name) in the same batch. A token of the other kind is `not_found`,
 * so the Recorders dialog never revokes an API token and the reverse.
 */
export async function revokeToken(
  db: Db,
  installId: string,
  input: { userId: string; tokenId: string; kind: TokenKind; now?: Date },
): Promise<'revoked' | 'already' | 'not_found'> {
  const now = input.now ?? new Date();
  const own = and(
    eq(tk.installId, installId),
    eq(tk.id, input.tokenId),
    eq(tk.userId, input.userId),
    eq(tk.kind, input.kind),
  );
  const live = and(own, isNull(tk.revokedAt));
  const recorder = input.kind === 'recorder';
  const [, revoked] = await db.batch([
    db.insert(auditEvents).select(
      db
        .select({
          id: value(crypto.randomUUID(), 'id'),
          installId: tk.installId,
          userId: tk.userId,
          meetingId: value(null, 'meeting_id'),
          meetingTitle: value(null, 'meeting_title'),
          action: value(recorder ? 'recorder_disconnected' : 'api_token_revoked', 'action'),
          details: (recorder
            ? sql<string>`json_object('device', ${tk.deviceName})`
            : input.kind === 'mcp'
              ? sql<string>`json_object('name', ${tk.deviceName}, 'scope', ${tk.scope}, 'kind', 'mcp')`
              : sql<string>`json_object('name', ${tk.deviceName}, 'scope', ${tk.scope})`
          ).as('details'),
          at: value(now.getTime(), 'at'),
        })
        .from(tk)
        .where(live),
    ),
    db.update(tk).set({ revokedAt: now }).where(live).returning({ id: tk.id }),
  ]);
  if (revoked.length) return 'revoked';
  const found = await db.select({ id: tk.id }).from(tk).where(own).limit(1);
  return found.length ? 'already' : 'not_found';
}

/**
 * The nightly job's share (docs/spec.md "Recorder connection"): grants that
 * expired over a day ago, whoever holds them, and tokens revoked or expired
 * over 90 days ago. A working token is never touched.
 */
export async function pruneRecorderRows(
  db: Db,
  installId: string,
  now: Date = new Date(),
): Promise<{ grants: number; tokens: number }> {
  const t = now.getTime();
  const tokenCutoff = new Date(t - TOKEN_KEEP_MS);
  const [grants, tokens] = await db.batch([
    db
      .delete(g)
      .where(and(eq(g.installId, installId), lt(g.expiresAt, new Date(t - GRANT_KEEP_MS))))
      .returning({ challenge: g.challenge }),
    db
      .delete(tk)
      .where(
        and(
          eq(tk.installId, installId),
          or(lt(tk.revokedAt, tokenCutoff), lt(tk.expiresAt, tokenCutoff)),
        ),
      )
      .returning({ id: tk.id }),
  ]);
  return { grants: grants.length, tokens: tokens.length };
}
