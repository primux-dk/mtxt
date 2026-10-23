import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AUDIT_ACTIONS, schema, type AuditAction, type Db } from '@mtxt/adapters';
import { AUDIT_PAGE_SIZE, type AuditParams } from './params';

export interface AuditRow {
  id: string;
  at: Date;
  action: AuditAction;
  user: { id: string; name: string; email: string };
  /** The meeting's title now, or the title the row was written with once the meeting is gone. */
  meetingTitle: string | null;
  meetingGone: boolean;
  owner: { name: string; email: string } | null;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  /** Per action pill, for the user filter without the action filter. */
  counts: Record<'all' | AuditAction, number>;
  page: number;
  pages: number;
  /** Everyone in the install, for the user filter. */
  users: { id: string; name: string; email: string }[];
  /** Names for the user ids a page's `shared` details mention. */
  names: Record<string, string>;
}

/**
 * One page of the audit log, for an admin. Metadata only: the events, who,
 * the meeting's title and owner. It joins users and meetings and nothing
 * else, so no transcript or recap is ever read here (docs/spec.md: admin
 * sees title, owner, dates and the audit log).
 */
export async function listAuditEvents(
  db: Db,
  installId: string,
  params: AuditParams,
): Promise<AuditPage> {
  const byUser = params.user ? sql`and a.user_id = ${params.user}` : sql``;
  const grouped = await db.all<{ action: AuditAction; n: number }>(sql`
    select a.action, count(*) as n from audit_events a
    where a.install_id = ${installId} ${byUser} group by a.action`);
  const counts = Object.fromEntries([
    ['all', grouped.reduce((n, g) => n + Number(g.n), 0)],
    ...AUDIT_ACTIONS.map((a) => [a, Number(grouped.find((g) => g.action === a)?.n ?? 0)]),
  ]) as AuditPage['counts'];
  const total = params.action ? counts[params.action] : counts.all;
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const page = Math.min(params.page, pages);
  const byAction = params.action ? sql`and a.action = ${params.action}` : sql``;

  const [rows, users] = await Promise.all([
    db.all<{
      id: string;
      at: number;
      action: AuditAction;
      user_id: string;
      user_name: string;
      user_email: string;
      meeting_id: string | null;
      title: string | null;
      snapshot: string | null;
      owner_name: string | null;
      owner_email: string | null;
      details: string | null;
    }>(sql`
      select a.id, a.at, a.action, a.user_id, u.name as user_name, u.email as user_email,
        m.id as meeting_id, m.title, a.meeting_title as snapshot,
        o.name as owner_name, o.email as owner_email, a.details
      from audit_events a
      join users u on u.id = a.user_id and u.install_id = ${installId}
      left join meetings m on m.id = a.meeting_id and m.install_id = ${installId}
      left join users o on o.id = m.owner_id and o.install_id = ${installId}
      where a.install_id = ${installId} ${byUser} ${byAction}
      order by a.at desc, a.id
      limit ${AUDIT_PAGE_SIZE} offset ${(page - 1) * AUDIT_PAGE_SIZE}`),
    db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.installId, installId))
      .orderBy(schema.users.name, schema.users.email),
  ]);

  const parsed = rows.map((r) => {
    let details: Record<string, unknown> | null = null;
    try {
      details = r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null;
    } catch {}
    return { ...r, details };
  });
  const mentioned = new Set<string>();
  for (const r of parsed) {
    if (r.action !== 'shared' || !r.details) continue;
    for (const key of ['before', 'after']) {
      const list = r.details[key];
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') mentioned.add(id);
    }
  }
  const names: Record<string, string> = {};
  if (mentioned.size) {
    const found = await db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.installId, installId),
          inArray(schema.users.id, [...mentioned].slice(0, 90)),
        ),
      );
    for (const u of found) names[u.id] = u.name;
  }

  return {
    rows: parsed.map((r) => ({
      id: r.id,
      at: new Date(Number(r.at)),
      action: r.action,
      user: { id: r.user_id, name: r.user_name, email: r.user_email },
      meetingTitle: r.title ?? r.snapshot,
      meetingGone: r.meeting_id === null,
      owner: r.owner_name !== null ? { name: r.owner_name, email: r.owner_email ?? '' } : null,
      details: r.details,
    })),
    total,
    counts,
    page,
    pages,
    users,
    names,
  };
}
