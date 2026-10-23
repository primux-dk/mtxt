import 'server-only';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import {
  detachAuditRows,
  dropFromSearchStatement,
  foreignRows,
  schema,
  type Db,
} from '@mtxt/adapters';
import { HttpError } from '../http-error';

/**
 * Rows of another install that hang off this meeting (packages/adapters,
 * src/db/integrity.ts). Retention uses the same count to leave such a
 * meeting alone.
 */
export { foreignRows };

/** Refuses a change to a meeting that another install's rows depend on. Nothing has been written. */
export async function assertOwnRowsOnly(db: Db, installId: string, meetingId: string) {
  if (await foreignRows(db, installId, meetingId)) {
    throw new HttpError(
      409,
      'install_conflict',
      'Rows of another install depend on this meeting; it was left as it is.',
    );
  }
}

/**
 * Deletes the meeting and everything under it, each table by name and by
 * install, in one batch (one transaction on D1), children first so no
 * cascade is left to run. Its audit rows stay, detached. `also` joins the
 * same transaction: the `deleted` audit row, so the delete and its row land
 * together or not at all. Call assertOwnRowsOnly first.
 */
export async function deleteMeetingRows(
  db: Db,
  installId: string,
  meetingId: string,
  also: BatchItem<'sqlite'>[] = [],
) {
  const t = schema;
  const recs = db
    .select({ id: t.recordings.id })
    .from(t.recordings)
    .where(and(eq(t.recordings.meetingId, meetingId), eq(t.recordings.installId, installId)));
  const trs = db
    .select({ id: t.transcripts.id })
    .from(t.transcripts)
    .where(and(inArray(t.transcripts.recordingId, recs), eq(t.transcripts.installId, installId)));
  const caps = db
    .select({ id: t.recaps.id })
    .from(t.recaps)
    .where(and(eq(t.recaps.meetingId, meetingId), eq(t.recaps.installId, installId)));
  const spk = db
    .select({ id: t.speakers.id })
    .from(t.speakers)
    .where(and(eq(t.speakers.meetingId, meetingId), eq(t.speakers.installId, installId)));
  await db.batch([
    // recaps.current_version_id points at a version: let go of it before the versions go.
    db.update(t.recaps).set({ currentVersionId: null }).where(inArray(t.recaps.id, caps)),
    db
      .delete(t.recapImages)
      .where(and(eq(t.recapImages.meetingId, meetingId), eq(t.recapImages.installId, installId))),
    db
      .delete(t.decisions)
      .where(and(inArray(t.decisions.recapId, caps), eq(t.decisions.installId, installId))),
    db
      .delete(t.recapVersions)
      .where(and(inArray(t.recapVersions.recapId, caps), eq(t.recapVersions.installId, installId))),
    db
      .delete(t.recaps)
      .where(and(eq(t.recaps.meetingId, meetingId), eq(t.recaps.installId, installId))),
    db
      .delete(t.segments)
      .where(
        and(
          or(inArray(t.segments.transcriptId, trs), inArray(t.segments.speakerId, spk)),
          eq(t.segments.installId, installId),
        ),
      ),
    db
      .delete(t.transcripts)
      .where(and(inArray(t.transcripts.recordingId, recs), eq(t.transcripts.installId, installId))),
    db
      .delete(t.speakers)
      .where(and(eq(t.speakers.meetingId, meetingId), eq(t.speakers.installId, installId))),
    db
      .delete(t.recordings)
      .where(and(eq(t.recordings.meetingId, meetingId), eq(t.recordings.installId, installId))),
    db
      .delete(t.meetingShares)
      .where(
        and(eq(t.meetingShares.meetingId, meetingId), eq(t.meetingShares.installId, installId)),
      ),
    // The audit log outlives the meeting: its rows let go of it and keep the title.
    detachAuditRows(db, installId, meetingId),
    dropFromSearchStatement(db, installId, meetingId),
    db
      .delete(t.meetings)
      .where(and(eq(t.meetings.id, meetingId), eq(t.meetings.installId, installId))),
    ...also,
  ]);
}
