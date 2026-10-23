import 'server-only';
import { and, eq } from 'drizzle-orm';
import { foldTitle, schema, syncSearch, type Db } from '@mtxt/adapters';
import { HttpError } from '../http-error';

/*
  The owner's plain changes to a meeting, as the library's actions and the
  REST API make them. Each sets a value, so a retry changes nothing twice.
*/
const m = schema.meetings;
const thisMeeting = (meetingId: string, installId: string) =>
  and(eq(m.id, meetingId), eq(m.installId, installId));

export const TITLE_MAX = 500;

/** A title as stored: trimmed, 1 to 500 characters; null when it is not one. */
export function cleanTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const clean = title.trim();
  return clean && clean.length <= TITLE_MAX ? clean : null;
}

/** Renames the meeting and its search row. */
export async function renameMeetingRows(db: Db, installId: string, meetingId: string, title: string) {
  const clean = cleanTitle(title);
  if (!clean) throw new HttpError(400, 'invalid_request', 'Title is 1 to 500 characters.');
  await db
    .update(m)
    .set({ title: clean, titleFolded: foldTitle(clean) })
    .where(thisMeeting(meetingId, installId));
  await syncSearch(db, installId, { meetingId, title: clean });
}

/** Sets the keep flag, which stops retention for the meeting. */
export const setKeepRow = (db: Db, installId: string, meetingId: string, keep: boolean) =>
  db.update(m).set({ keep }).where(thisMeeting(meetingId, installId));
