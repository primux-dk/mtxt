import 'server-only';
import { and, eq, notExists, sql } from 'drizzle-orm';
import { auditStatement, schema, type Db, type Meeting, type Visibility } from '@mtxt/adapters';
import { HttpError } from '../http-error';

const m = schema.meetings;
const s = schema.meetingShares;

/** The meeting's share list, sorted, for the audit row's before and after. */
export async function shareIds(db: Db, installId: string, meetingId: string) {
  const rows = await db
    .select({ userId: s.userId })
    .from(s)
    .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)));
  return rows.map((row) => row.userId).sort();
}

const isMeeting = (installId: string, meeting: Pick<Meeting, 'id' | 'ownerId'>) =>
  and(eq(m.id, meeting.id), eq(m.installId, installId), eq(m.ownerId, meeting.ownerId));

/**
 * The owner sets the visibility. One D1 batch, one transaction: the update
 * (only from the value the owner saw), the share rows going when it is no
 * longer Shared, and the audit row. If any of them fails, none lands. A
 * value someone else changed in between is a conflict, not an overwrite.
 */
export async function changeVisibility(
  db: Db,
  installId: string,
  meeting: Pick<Meeting, 'id' | 'ownerId' | 'title' | 'visibility'>,
  visibility: Visibility,
): Promise<'unchanged' | 'changed'> {
  if (meeting.visibility === visibility) return 'unchanged';
  const removed =
    meeting.visibility === 'shared' ? (await shareIds(db, installId, meeting.id)).length : 0;
  await db.batch([
    db
      .update(m)
      .set({ visibility })
      .where(and(isMeeting(installId, meeting), eq(m.visibility, meeting.visibility))),
    // Shares exist only while Shared; whatever arrived meanwhile goes with the change.
    db
      .delete(s)
      .where(
        and(
          eq(s.installId, installId),
          eq(s.meetingId, meeting.id),
          sql`(select ${m.visibility} from ${m} where ${m.id} = ${meeting.id} and ${m.installId} = ${installId}) != 'shared'`,
        ),
      ),
    auditStatement(
      db,
      installId,
      {
        userId: meeting.ownerId,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        action: 'visibility_changed',
        details: {
          before: meeting.visibility,
          after: visibility,
          ...(removed ? { sharesRemoved: removed } : {}),
        },
      },
      and(isMeeting(installId, meeting), eq(m.visibility, visibility)),
    ),
  ]);
  const [now] = await db
    .select({ visibility: m.visibility })
    .from(m)
    .where(isMeeting(installId, meeting));
  if (now?.visibility !== visibility)
    throw new HttpError(409, 'install_conflict', 'The visibility changed meanwhile.');
  return 'changed';
}

/**
 * The owner adds or removes a colleague. Adding is an insert from the
 * meeting row itself, so it lands only while the meeting is Shared at that
 * moment; its audit row carries the same condition, in the same batch. A
 * change to Private in between leaves no share and no audit row, and the
 * screen rolls back.
 */
export async function changeShare(
  db: Db,
  installId: string,
  meeting: Pick<Meeting, 'id' | 'ownerId' | 'title'>,
  userId: string,
  shared: boolean,
): Promise<'unchanged' | 'changed'> {
  if (userId === meeting.ownerId)
    throw new HttpError(400, 'invalid_request', 'The owner already has it.');
  const colleague = await db.query.users.findFirst({
    where: and(eq(schema.users.id, userId), eq(schema.users.installId, installId)),
  });
  if (!colleague) throw new HttpError(400, 'invalid_request', 'No such colleague.');
  const before = await shareIds(db, installId, meeting.id);
  if (before.includes(userId) === shared) return 'unchanged';
  const after = shared ? [...before, userId].sort() : before.filter((id) => id !== userId);
  const audit = (onlyIf: ReturnType<typeof and>) =>
    auditStatement(
      db,
      installId,
      {
        userId: meeting.ownerId,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        action: 'shared',
        details: { before, after },
      },
      onlyIf,
    );

  if (shared) {
    const stillShared = and(isMeeting(installId, meeting), eq(m.visibility, 'shared'));
    const absent = notExists(
      db
        .select({ one: sql`1` })
        .from(s)
        .where(and(eq(s.installId, installId), eq(s.meetingId, meeting.id), eq(s.userId, userId))),
    );
    await db.batch([
      // The audit row first: it reads the same "not there yet" the insert does.
      audit(and(stillShared, absent)),
      db.insert(s).select(
        db
          .select({
            installId: m.installId,
            meetingId: m.id,
            userId: sql<string>`${userId}`.as('user_id'),
          })
          .from(m)
          .where(and(stillShared, absent)),
      ),
    ]);
    if (!(await shareIds(db, installId, meeting.id)).includes(userId))
      throw new HttpError(400, 'invalid_request', 'The meeting is not Shared.');
    return 'changed';
  }
  await db.batch([
    db
      .delete(s)
      .where(and(eq(s.installId, installId), eq(s.meetingId, meeting.id), eq(s.userId, userId))),
    audit(isMeeting(installId, meeting)),
  ]);
  return 'changed';
}
