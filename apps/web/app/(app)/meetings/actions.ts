'use server';

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  auditStatement,
  cleanupEntries,
  finishCleanup,
  foldTitle,
  recordCleanup,
  schema,
  syncSearch,
} from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { assertOwnRowsOnly, deleteMeetingRows } from '@/lib/meetings/integrity';
import { resetForRetry } from '@/lib/transcription/store';
import { asOwner, outcome, type ActionResult } from '@/lib/meetings/owner-action';

/** The owner's changes to a meeting. Each answers with the outcome; the screen rolls back on `ok: false`. */
export type { ActionResult };

const m = schema.meetings;
const r = schema.recordings;
const thisMeeting = (meetingId: string, installId: string) =>
  and(eq(m.id, meetingId), eq(m.installId, installId));

export async function renameMeeting(meetingId: string, title: string): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId }) => {
      const clean = title.trim();
      if (!clean || clean.length > 500)
        throw new HttpError(400, 'invalid_request', 'Title is 1 to 500 characters.');
      await db
        .update(m)
        .set({ title: clean, titleFolded: foldTitle(clean) })
        .where(thisMeeting(meetingId, installId));
      await syncSearch(db, installId, { meetingId, title: clean });
    }),
  );
}

export async function setKeep(meetingId: string, keep: boolean): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, ({ db, installId }) =>
      db.update(m).set({ keep }).where(thisMeeting(meetingId, installId)),
    ),
  );
}

export async function setArchived(meetingId: string, archived: boolean): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId }) => {
      // Archive is refused like delete when another install's rows depend on the meeting.
      await assertOwnRowsOnly(db, installId, meetingId);
      await db
        .update(m)
        .set({ archivedAt: archived ? new Date() : null })
        .where(thisMeeting(meetingId, installId));
    }),
  );
}

/**
 * Deletes the meeting for good. Refused, with nothing removed, when another
 * install's rows depend on it (lib/meetings/integrity.ts). The rows go
 * first, in one transaction with the `deleted` audit row and a record of
 * every storage object to remove (`storage_cleanup`): if any part fails,
 * nothing changes and the audio still plays. Only after that commit are
 * open uploads aborted and the objects deleted; one storage refuses stays
 * recorded, and the nightly job retries it. The owner also removes a
 * meeting retention has already emptied this way.
 */
export async function deleteMeeting(meetingId: string): Promise<ActionResult> {
  return outcome(() =>
    asOwner(
      meetingId,
      async ({ db, storage, uploads, installId, user, meeting }) => {
        await assertOwnRowsOnly(db, installId, meetingId);
        const recordings = await db.query.recordings.findMany({
          where: and(eq(r.meetingId, meetingId), eq(r.installId, installId)),
        });
        const recap = await db.query.recaps.findFirst({
          where: and(
            eq(schema.recaps.meetingId, meetingId),
            eq(schema.recaps.installId, installId),
          ),
        });
        // The providers' raw results live in storage too (transcripts.raw_path).
        const raws = recordings.length
          ? await db
              .select({ path: schema.transcripts.rawPath })
              .from(schema.transcripts)
              .where(
                and(
                  inArray(
                    schema.transcripts.recordingId,
                    recordings.map((rec) => rec.id),
                  ),
                  eq(schema.transcripts.installId, installId),
                ),
              )
          : [];
        const cleanup = cleanupEntries([
          ...recordings.map((rec) => rec.storagePath),
          ...raws.flatMap((raw) => (raw.path ? [raw.path] : [])),
          ...(recap?.docxPath ? [recap.docxPath] : []),
        ]);
        const record = recordCleanup(db, installId, cleanup);
        await deleteMeetingRows(db, installId, meetingId, [
          auditStatement(db, installId, {
            userId: user.id,
            meetingId: null,
            meetingTitle: meeting.title,
            action: 'deleted',
          }),
          ...(record ? [record] : []),
        ]);
        // Committed. From here on nothing undoes the delete; storage catches up.
        await Promise.all(
          recordings
            .filter((rec) => rec.status === 'uploading')
            .map((rec) =>
              uploads
                .get(rec.id)
                .abort()
                .catch((error: unknown) =>
                  console.error('Could not abort an upload', rec.id, error),
                ),
            ),
        );
        await finishCleanup(db, storage, installId, cleanup);
      },
      { deleted: true },
    ),
  );
}

/** Moves `is_primary` to another confirmed recording of the meeting. */
export async function setPrimaryRecording(
  meetingId: string,
  recordingId: string,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId }) => {
      const target = await db.query.recordings.findFirst({
        where: and(
          eq(r.id, recordingId),
          eq(r.installId, installId),
          eq(r.meetingId, meetingId),
          isNotNull(r.confirmedAt),
        ),
      });
      if (!target)
        throw new HttpError(400, 'invalid_request', 'Only a confirmed recording can be primary.');
      // Clear first, then set: the unique index allows one primary at a time.
      await db.batch([
        db
          .update(r)
          .set({ isPrimary: false })
          .where(and(eq(r.meetingId, meetingId), eq(r.installId, installId))),
        db
          .update(r)
          .set({ isPrimary: true })
          .where(and(eq(r.id, recordingId), eq(r.installId, installId))),
      ]);
    }),
  );
}

/** Queues transcription again for a recording whose transcription failed. */
export async function retryTranscription(
  meetingId: string,
  recordingId: string,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, queue, installId }) => {
      const before = await db.query.recordings.findFirst({
        where: and(eq(r.id, recordingId), eq(r.installId, installId)),
      });
      // The recording and its transcript row go back to a fresh attempt together; this is
      // the one place a failed row is reset (the job never does it).
      const updated = await resetForRetry(db, installId, meetingId, recordingId);
      // Already queued by an earlier click: nothing to do, and no second job.
      if (!updated) return;
      try {
        await queue.send({ type: 'transcribe', recording_id: recordingId, install_id: installId });
      } catch (error) {
        // Back to the failure the page showed, reason and all.
        await db
          .update(r)
          .set({
            status: 'failed',
            failure: before?.failure ?? null,
            failureReason: before?.failureReason ?? null,
          })
          .where(and(eq(r.id, recordingId), eq(r.installId, installId)));
        throw error;
      }
    }),
  );
}
