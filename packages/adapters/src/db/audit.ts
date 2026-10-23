import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from './index';
import { auditEvents, meetings, type AuditAction, type Visibility } from './schema';

/** `opened` is written at most once per user, meeting and window, so a reload does not flood the log. */
export const OPENED_WINDOW_MS = 60 * 60 * 1000;

/** What `details` holds, per action. User ids, so a renamed colleague shows under the new name. */
/**
 * A row written for a REST call: `via: 'api'` with a personal API token, or
 * `via: 'mcp'` through the MCP server (docs/spec.md "MCP"), and the token's
 * or the MCP client's name.
 */
export interface ViaApi {
  via: 'api' | 'mcp';
  token: string;
}

export type AuditDetails =
  | ({ before: Visibility; after: Visibility; sharesRemoved?: number } & Partial<ViaApi>)
  | ({ before: string[]; after: string[] } & Partial<ViaApi>)
  /** `opened` through the API. A page's `opened` has no details. */
  | ViaApi
  /** `exported`: which file the reader took; `via: 'webhook'` when an endpoint fetched a link. */
  | { format: 'md' | 'docx' | 'transcript'; via?: 'webhook'; endpoint?: string | null }
  /** `exported` through the API: the transcript as JSON or text, the recap as markdown, Word or JSON. */
  | ({ format: 'md' | 'docx' | 'json' | 'transcript' | 'text' } & ViaApi)
  /** `webhook_sent`: the endpoint's label (null when it has none) and the event it took. */
  | { endpoint: string | null; event: string }
  /** `api_token_created` and `api_token_revoked`: the token's name and scope; `kind: 'mcp'` for an MCP connection. */
  | { name: string; scope: string | null; kind?: 'mcp' }
  /** `mcp_write`: an MCP tool's write that has no action of its own (a recap save), and the version it made. */
  | ({ tool: string; version: number } & ViaApi);

export interface AuditEventInput {
  userId: string;
  /** Null when the meeting is gone by the time the row is written (`deleted`). */
  meetingId: string | null;
  /** The title now, kept on the row so the log still names the meeting after it is deleted. */
  meetingTitle: string | null;
  action: AuditAction;
  details?: AuditDetails;
  at?: Date;
}

/**
 * The one way an audit row is written. `opened` is skipped when the same
 * user has an `opened` row on the same meeting, by the same way (the page
 * or `via: 'api'`), inside OPENED_WINDOW_MS; the
 * check and the insert are one statement. Every other action is always
 * written. Answers whether a row was written.
 */
export async function audit(db: Db, installId: string, event: AuditEventInput): Promise<boolean> {
  const at = (event.at ?? new Date()).getTime();
  const id = crypto.randomUUID();
  const details = event.details ? JSON.stringify(event.details) : null;
  const values = sql`${id}, ${installId}, ${event.userId}, ${event.meetingId}, ${event.meetingTitle}, ${event.action}, ${details}, ${at}`;
  const columns = sql.raw(
    'id, install_id, user_id, meeting_id, meeting_title, action, details, at',
  );
  if (event.action !== 'opened' || !event.meetingId) {
    await db.run(sql`insert into audit_events (${columns}) values (${values})`);
    return true;
  }
  // A page's opens and the API's are counted apart, so neither hides the other.
  const via = (event.details && 'via' in event.details && event.details.via) || '';
  const rows = await db.all<{ id: string }>(sql`
    insert into audit_events (${columns})
    select ${values}
    where not exists (
      select 1 from audit_events
      where install_id = ${installId} and meeting_id = ${event.meetingId}
        and user_id = ${event.userId} and action = 'opened' and at > ${at - OPENED_WINDOW_MS}
        and coalesce(json_extract(details, '$.via'), '') = ${via}
    )
    returning id`);
  return rows.length > 0;
}

/**
 * The audit row of a mutation, as a statement for the mutation's own D1
 * batch, so the change and its row land together or not at all (D1 runs a
 * batch as one transaction). With `onlyIf`, a condition on `meetings`, the
 * row is written only when that condition holds inside the batch: for an
 * insert that may itself do nothing, such as a share on a meeting that is
 * no longer Shared. `opened` goes through audit(), which deduplicates.
 */
export function auditStatement(db: Db, installId: string, event: AuditEventInput, onlyIf?: SQL) {
  const row = {
    id: crypto.randomUUID(),
    installId,
    userId: event.userId,
    meetingId: event.meetingId,
    meetingTitle: event.meetingTitle,
    action: event.action,
    details: (event.details ?? null) as Record<string, unknown> | null,
    at: event.at ?? new Date(),
  };
  if (!onlyIf) return db.insert(auditEvents).values(row);
  // Columns in the table's order; each value bound, selected once when the condition holds.
  const value = <T>(v: T, column: string) => sql<T>`${v}`.as(column);
  return db.insert(auditEvents).select(
    db
      .select({
        id: value(row.id, 'id'),
        installId: value(row.installId, 'install_id'),
        userId: value(row.userId, 'user_id'),
        meetingId: value(row.meetingId, 'meeting_id'),
        meetingTitle: value(row.meetingTitle, 'meeting_title'),
        action: value(row.action, 'action'),
        details: value(row.details ? JSON.stringify(row.details) : null, 'details'),
        at: value(row.at.getTime(), 'at'),
      })
      .from(meetings)
      .where(onlyIf)
      .limit(1),
  );
}

/**
 * Detaches a meeting's audit rows before the meeting is deleted: the log
 * outlives what it logs, and `meeting_title` keeps the name.
 */
export const detachAuditRows = (db: Db, installId: string, meetingId: string) =>
  db
    .update(auditEvents)
    .set({ meetingId: null })
    .where(and(eq(auditEvents.installId, installId), eq(auditEvents.meetingId, meetingId)));
