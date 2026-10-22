import 'server-only';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@mtxt/adapters';
import { HttpError } from '../http-error';

/**
 * Rows of another install that hang off this meeting, through any foreign
 * key: shares, recordings, speakers, recaps and audit rows on the meeting;
 * transcripts and segments under its recordings; versions and decisions
 * under its recap. The schema's foreign keys are one column, so a cascade
 * would delete them; nothing here may.
 */
export async function foreignRows(db: Db, installId: string, meetingId: string): Promise<number> {
  const [row] = await db.all<{ n: number }>(sql`
    with
      recs as (select id, install_id from recordings where meeting_id = ${meetingId}),
      trs as (select id, install_id from transcripts where recording_id in (select id from recs)),
      caps as (select id, install_id from recaps where meeting_id = ${meetingId})
    select
      (select count(*) from meeting_shares where meeting_id = ${meetingId} and install_id != ${installId})
    + (select count(*) from recs where install_id != ${installId})
    + (select count(*) from speakers where meeting_id = ${meetingId} and install_id != ${installId})
    + (select count(*) from caps where install_id != ${installId})
    + (select count(*) from audit_events where meeting_id = ${meetingId} and install_id != ${installId})
    + (select count(*) from trs where install_id != ${installId})
    + (select count(*) from segments where transcript_id in (select id from trs) and install_id != ${installId})
    + (select count(*) from segments where speaker_id in (select id from speakers where meeting_id = ${meetingId}) and install_id != ${installId})
    + (select count(*) from recap_versions where recap_id in (select id from caps) and install_id != ${installId})
    + (select count(*) from decisions where recap_id in (select id from caps) and install_id != ${installId})
    as n`);
  return Number(row?.n ?? 0);
}

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
 * cascade is left to run. Call assertOwnRowsOnly first.
 */
export async function deleteMeetingRows(db: Db, installId: string, meetingId: string) {
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
    db
      .delete(t.auditEvents)
      .where(and(eq(t.auditEvents.meetingId, meetingId), eq(t.auditEvents.installId, installId))),
    db
      .delete(t.meetings)
      .where(and(eq(t.meetings.id, meetingId), eq(t.meetings.installId, installId))),
  ]);
}
