import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './index';
import { auditEvents, type AuditAction, type Visibility } from './schema';

/** `opened` is written at most once per user, meeting and window, so a reload does not flood the log. */
export const OPENED_WINDOW_MS = 60 * 60 * 1000;

/** What `details` holds, per action. User ids, so a renamed colleague shows under the new name. */
export type AuditDetails =
  | { before: Visibility; after: Visibility; sharesRemoved?: number }
  | { before: string[]; after: string[] };

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
 * user has an `opened` row on the same meeting inside OPENED_WINDOW_MS; the
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
  const rows = await db.all<{ id: string }>(sql`
    insert into audit_events (${columns})
    select ${values}
    where not exists (
      select 1 from audit_events
      where install_id = ${installId} and meeting_id = ${event.meetingId}
        and user_id = ${event.userId} and action = 'opened' and at > ${at - OPENED_WINDOW_MS}
    )
    returning id`);
  return rows.length > 0;
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
