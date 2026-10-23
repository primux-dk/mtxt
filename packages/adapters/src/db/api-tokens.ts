import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { API_RATE_LIMIT, API_RATE_WINDOW_MS, MAX_API_TOKENS, rateAllowed } from '../recorder-auth';
import type { Db } from './index';
import { auditEvents, recorderTokens, users, type ApiTokenScope } from './schema';

/*
  Personal API tokens (docs/spec.md "API"). They share `recorder_tokens`
  with the recorders' tokens, as `kind = 'api'`: one bearer lookup, one
  `last_used_at` rule and one nightly prune serve both. The token itself is
  never stored, only its SHA-256. Every statement carries install_id.
*/

const tk = recorderTokens;

/** A bound value selected under a column's name, for INSERT ... SELECT in the table's column order. */
const value = <T>(v: T, column: string) => sql<T>`${v}`.as(column);

export interface ApiTokenRow {
  id: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

/**
 * Makes an API token row and its `api_token_created` audit row in one
 * batch. The 26th working token of a user is refused inside the same
 * statements (`too_many`), so two creates at once cannot pass the cap.
 */
export async function createApiToken(
  db: Db,
  installId: string,
  input: {
    userId: string;
    name: string;
    scope: ApiTokenScope;
    tokenHash: string;
    expiresAt: Date;
    now?: Date;
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: 'too_many' }> {
  const now = (input.now ?? new Date()).getTime();
  const id = crypto.randomUUID();
  const room = sql`(
    select count(*) from recorder_tokens
    where install_id = ${installId} and user_id = ${input.userId} and kind = 'api'
      and revoked_at is null and expires_at > ${now}
  ) < ${MAX_API_TOKENS}`;
  const owner = and(eq(users.installId, installId), eq(users.id, input.userId), room);
  const [, created] = await db.batch([
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
          details: value(JSON.stringify({ name: input.name, scope: input.scope }), 'details'),
          at: value(now, 'at'),
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
            deviceName: value(input.name, 'device_name'),
            tokenHash: value(input.tokenHash, 'token_hash'),
            createdAt: value(now, 'created_at'),
            lastUsedAt: value(null, 'last_used_at'),
            expiresAt: value(input.expiresAt.getTime(), 'expires_at'),
            revokedAt: value(null, 'revoked_at'),
            kind: value('api', 'kind'),
            scope: value(input.scope, 'scope'),
            rateWindowAt: value(null, 'rate_window_at'),
            rateCount: value(0, 'rate_count'),
          })
          .from(users)
          .where(owner),
      )
      .returning({ id: tk.id }),
  ]);
  return created.length ? { ok: true, id } : { ok: false, reason: 'too_many' };
}

/** A user's working API tokens, newest first. Revoked and expired ones are left out. */
export async function listApiTokens(
  db: Db,
  installId: string,
  userId: string,
  now: Date = new Date(),
): Promise<ApiTokenRow[]> {
  const rows = await db
    .select({
      id: tk.id,
      name: tk.deviceName,
      scope: tk.scope,
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
        eq(tk.kind, 'api'),
        isNull(tk.revokedAt),
        gt(tk.expiresAt, now),
      ),
    )
    .orderBy(desc(tk.createdAt), tk.id)
    .limit(MAX_API_TOKENS * 2);
  return rows.map((r) => ({ ...r, scope: r.scope ?? 'read' }));
}

export type RateResult =
  { ok: true; remaining: number } | { ok: false; retryAfter: number; remaining: 0 };

/**
 * Counts one request against the token's minute (docs/spec.md "API": 60 a
 * minute per token). One conditional UPDATE starts a new window or adds to
 * the current one while it has room, so two requests at once never both
 * take the last place. A refused request writes nothing and answers how
 * long the window still runs.
 */
export async function takeApiRequest(
  db: Db,
  installId: string,
  tokenId: string,
  now: Date = new Date(),
): Promise<RateResult> {
  const t = now.getTime();
  const expired = sql`(${tk.rateWindowAt} is null or ${tk.rateWindowAt} <= ${t - API_RATE_WINDOW_MS})`;
  const taken = await db
    .update(tk)
    .set({
      rateWindowAt: sql`case when ${expired} then ${t} else ${tk.rateWindowAt} end`,
      rateCount: sql`case when ${expired} then 1 else ${tk.rateCount} + 1 end`,
    })
    .where(
      and(
        eq(tk.installId, installId),
        eq(tk.id, tokenId),
        sql`(${expired} or ${tk.rateCount} < ${API_RATE_LIMIT})`,
      ),
    )
    .returning({ count: tk.rateCount });
  if (taken[0]) return { ok: true, remaining: Math.max(0, API_RATE_LIMIT - taken[0].count) };
  const [row] = await db
    .select({ at: tk.rateWindowAt, count: tk.rateCount })
    .from(tk)
    .where(and(eq(tk.installId, installId), eq(tk.id, tokenId)));
  const verdict = rateAllowed({ at: row?.at?.getTime() ?? null, count: row?.count ?? 0 }, t);
  return { ok: false, retryAfter: verdict.ok ? 1 : verdict.retryAfter, remaining: 0 };
}
