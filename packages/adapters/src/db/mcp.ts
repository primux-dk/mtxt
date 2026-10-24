import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  GRANT_KEEP_MS,
  MAX_MCP_CONNECTIONS,
  MCP_ACCESS_LIFETIME_MS,
  MCP_CONNECTION_LIFETIME_MS,
  OAUTH_CODE_LIFETIME_MS,
  safeEqual,
} from '../recorder-auth';
import type { Db } from './index';
import { revokeToken } from './recorders';
import { auditEvents, oauthGrants, recorderTokens, users, type ApiTokenScope } from './schema';

/*
  The MCP server's OAuth rows (docs/spec.md "MCP"). Approve on
  /oauth/authorize writes an authorization code; /oauth/token exchanges it
  once for a connection: a `recorder_tokens` row with `kind = 'mcp'`, whose
  `token_hash` is the current access token and `refresh_hash` the current
  refresh token, both rotated by each refresh. Codes and tokens are stored
  as their SHA-256 only. Every statement carries install_id.
*/

const tk = recorderTokens;
const og = oauthGrants;

/** A bound value selected under a column's name, for INSERT ... SELECT in the table's column order. */
const value = <T>(v: T, column: string) => sql<T>`${v}`.as(column);

/** A user's working MCP connections. */
export async function countMcpConnections(
  db: Db,
  installId: string,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tk)
    .where(
      and(
        eq(tk.installId, installId),
        eq(tk.userId, userId),
        eq(tk.kind, 'mcp'),
        isNull(tk.revokedAt),
        gt(tk.expiresAt, now),
      ),
    );
  return Number(row?.n ?? 0);
}

export interface OAuthCodeInput {
  codeHash: string;
  userId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scope: ApiTokenScope;
  now?: Date;
}

/** Approve: the code the client exchanges at the token endpoint, valid OAUTH_CODE_LIFETIME_MS. */
export async function createOAuthCode(db: Db, installId: string, input: OAuthCodeInput) {
  const now = input.now ?? new Date();
  await db.insert(og).values({
    installId,
    codeHash: input.codeHash,
    userId: input.userId,
    clientId: input.clientId,
    clientName: input.clientName,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OAUTH_CODE_LIFETIME_MS),
  });
}

export type IssueResult =
  | { ok: true; tokenId: string; scope: ApiTokenScope; accessExpiresAt: Date }
  | { ok: false; reason: 'invalid_grant' | 'too_many' };

/**
 * The token endpoint's code exchange. The code must be unused, unexpired,
 * for this client and redirect URI, and its challenge the S256 of the
 * client's verifier (`challenge`, worked out by the caller). The code is
 * taken and the connection made in one batch; the 26th working connection
 * of a user is refused inside the same statements. A code presented again
 * revokes the connection it became (RFC 6749 section 4.1.2), also when the
 * two exchanges ran at once and this one lost the claim.
 */
export async function redeemOAuthCode(
  db: Db,
  installId: string,
  input: {
    codeHash: string;
    clientId: string;
    redirectUri: string;
    challenge: string;
    accessHash: string;
    refreshHash: string;
    now?: Date;
  },
): Promise<IssueResult> {
  const now = input.now ?? new Date();
  const t = now.getTime();
  const grant = await db.query.oauthGrants.findFirst({
    where: and(eq(og.installId, installId), eq(og.codeHash, input.codeHash)),
  });
  if (!grant || !safeEqual(grant.codeHash, input.codeHash))
    return { ok: false, reason: 'invalid_grant' };
  /** A code used twice: the connection it became stops working (RFC 6749 section 4.1.2). */
  const replayed = async (tokenId: string | null): Promise<IssueResult> => {
    if (tokenId)
      await revokeToken(db, installId, { userId: grant.userId, tokenId, kind: 'mcp', now });
    return { ok: false, reason: 'invalid_grant' };
  };
  if (grant.redeemedAt) return replayed(grant.tokenId);
  if (
    grant.expiresAt.getTime() <= t ||
    grant.clientId !== input.clientId ||
    grant.redirectUri !== input.redirectUri ||
    !safeEqual(grant.codeChallenge, input.challenge)
  ) {
    return { ok: false, reason: 'invalid_grant' };
  }

  const id = crypto.randomUUID();
  const accessExpiresAt = new Date(t + MCP_ACCESS_LIFETIME_MS);
  // Only the request that took the code makes the connection, and only while the user has room.
  const taken = sql`exists (select 1 from oauth_grants where install_id = ${installId}
    and code_hash = ${input.codeHash} and token_id = ${id})`;
  const room = sql`(
    select count(*) from recorder_tokens
    where install_id = ${installId} and user_id = ${grant.userId} and kind = 'mcp'
      and revoked_at is null and expires_at > ${t}
  ) < ${MAX_MCP_CONNECTIONS}`;
  const owner = and(eq(users.installId, installId), eq(users.id, grant.userId), taken, room);
  const [claimed, , created] = await db.batch([
    db
      .update(og)
      .set({ redeemedAt: now, tokenId: id })
      .where(
        and(eq(og.installId, installId), eq(og.codeHash, input.codeHash), isNull(og.redeemedAt)),
      )
      .returning({ codeHash: og.codeHash }),
    // The audit row first: it reads the same count the insert does.
    db.insert(auditEvents).select(
      db
        .select({
          id: value(crypto.randomUUID(), 'id'),
          installId: users.installId,
          userId: users.id,
          meetingId: value(null, 'meeting_id'),
          meetingTitle: value(null, 'meeting_title'),
          action: value('api_token_created', 'action'),
          details: value(
            JSON.stringify({ name: grant.clientName, scope: grant.scope, kind: 'mcp' }),
            'details',
          ),
          at: value(t, 'at'),
        })
        .from(users)
        .where(owner),
    ),
    db
      .insert(tk)
      .select(
        db
          .select({
            id: value(id, 'id'),
            installId: users.installId,
            userId: users.id,
            deviceName: value(grant.clientName, 'device_name'),
            tokenHash: value(input.accessHash, 'token_hash'),
            createdAt: value(t, 'created_at'),
            lastUsedAt: value(null, 'last_used_at'),
            expiresAt: value(t + MCP_CONNECTION_LIFETIME_MS, 'expires_at'),
            revokedAt: value(null, 'revoked_at'),
            kind: value('mcp', 'kind'),
            scope: value(grant.scope, 'scope'),
            rateWindowAt: value(null, 'rate_window_at'),
            rateCount: value(0, 'rate_count'),
            clientId: value(grant.clientId, 'client_id'),
            refreshHash: value(input.refreshHash, 'refresh_hash'),
            accessExpiresAt: value(accessExpiresAt.getTime(), 'access_expires_at'),
          })
          .from(users)
          .where(owner),
      )
      .returning({ id: tk.id }),
  ]);
  if (!claimed.length) {
    // Another exchange of the same code took it between the read and the batch; its batch
    // has committed, connection included, so the code is a replay here too.
    const taken = await db.query.oauthGrants.findFirst({
      where: and(eq(og.installId, installId), eq(og.codeHash, input.codeHash)),
    });
    return replayed(taken?.tokenId ?? null);
  }
  if (!created.length) return { ok: false, reason: 'too_many' };
  return { ok: true, tokenId: id, scope: grant.scope, accessExpiresAt };
}

/**
 * The token endpoint's refresh: a working connection of this client, found
 * by its current refresh token, gets a new access token and a new refresh
 * token (the old one stops working), and its end moves on. One conditional
 * UPDATE, so two refreshes with the same token cannot both succeed.
 */
export async function refreshMcpToken(
  db: Db,
  installId: string,
  input: {
    refreshHash: string;
    clientId: string;
    accessHash: string;
    nextRefreshHash: string;
    now?: Date;
  },
): Promise<IssueResult> {
  const now = input.now ?? new Date();
  const t = now.getTime();
  const accessExpiresAt = new Date(t + MCP_ACCESS_LIFETIME_MS);
  const [row] = await db
    .update(tk)
    .set({
      tokenHash: input.accessHash,
      refreshHash: input.nextRefreshHash,
      accessExpiresAt,
      expiresAt: new Date(t + MCP_CONNECTION_LIFETIME_MS),
    })
    .where(
      and(
        eq(tk.installId, installId),
        eq(tk.kind, 'mcp'),
        eq(tk.refreshHash, input.refreshHash),
        eq(tk.clientId, input.clientId),
        isNull(tk.revokedAt),
        gt(tk.expiresAt, now),
        sql`exists (select 1 from users u where u.install_id = ${installId} and u.id = ${tk.userId})`,
      ),
    )
    .returning({ id: tk.id, scope: tk.scope });
  if (!row) return { ok: false, reason: 'invalid_grant' };
  return { ok: true, tokenId: row.id, scope: row.scope ?? 'read', accessExpiresAt };
}

/**
 * RFC 7009 revocation: the connection whose access or refresh token this
 * is, for the client that holds it, stops working. Answers whether one did.
 */
export async function revokeMcpToken(
  db: Db,
  installId: string,
  input: { tokenHash: string; clientId: string; now?: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ id: tk.id, userId: tk.userId })
    .from(tk)
    .where(
      and(
        eq(tk.installId, installId),
        eq(tk.kind, 'mcp'),
        eq(tk.clientId, input.clientId),
        sql`(${tk.tokenHash} = ${input.tokenHash} or ${tk.refreshHash} = ${input.tokenHash})`,
      ),
    )
    .limit(1);
  if (!row) return false;
  const result = await revokeToken(db, installId, {
    userId: row.userId,
    tokenId: row.id,
    kind: 'mcp',
    now: input.now,
  });
  return result === 'revoked';
}

/** The nightly job's share: authorization codes that expired over a day ago. */
export async function pruneOAuthGrants(
  db: Db,
  installId: string,
  now: Date = new Date(),
): Promise<number> {
  const gone = await db
    .delete(og)
    .where(
      and(eq(og.installId, installId), lt(og.expiresAt, new Date(now.getTime() - GRANT_KEEP_MS))),
    )
    .returning({ codeHash: og.codeHash });
  return gone.length;
}
