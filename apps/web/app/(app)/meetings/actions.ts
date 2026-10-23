'use server';

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  auditStatement,
  cleanupEntries,
  finishCleanup,
  recordCleanup,
  schema,
} from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { renameMeetingRows, setKeepRow } from '@/lib/meetings/changes';
import { assertOwnRowsOnly, deleteMeetingRows } from '@/lib/meetings/integrity';
import { resetForRetry } from '@/lib/transcription/store';
import { asOwner, outcome, type ActionResult } from '@/lib/meetings/owner-action';
import { planDeleted, queueCurrentState, queueDeleted } from '@/lib/webhooks/store';

/** The owner's changes to a meeting. Each answers with the outcome; the screen rolls back on `ok: false`. */
export type { ActionResult };

const m = schema.meetings;
const r = schema.recordings;
const thisMeeting = (meetingId: string, installId: string) =>
  and(eq(m.id, meetingId), eq(m.installId, installId));

export async function renameMeeting(meetingId: string, title: string): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, ({ db, installId }) => renameMeetingRows(db, installId, meetingId, title)),
  );
}

export async function setKeep(meetingId: string, keep: boolean): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, ({ db, installId }) => setKeepRow(db, installId, meetingId, keep)),
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
      async ({ db, storage, uploads, queue, installId, user, meeting }) => {
        await assertOwnRowsOnly(db, installId, meetingId);
        // Who must hear of the delete, worked out while the meeting is still there.
        const deletedEvent = await planDeleted(db, installId, meetingId).catch((error: unknown) => {
          console.error('Could not plan meeting.deleted', (error as Error).name);
          return null;
        });
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
          // The recap's images, each registered when it was uploaded.
          ...(
            await db
              .select({ path: schema.recapImages.path })
              .from(schema.recapImages)
              .where(
                and(
                  eq(schema.recapImages.meetingId, meetingId),
                  eq(schema.recapImages.installId, installId),
                ),
              )
          ).map((image) => image.path),
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
        if (deletedEvent) await queueDeleted({ db, installId, queue }, deletedEvent);
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

export type SendResult =
  | { ok: true; queued: number; transcript: boolean; recap: boolean }
  | Extract<ActionResult, { ok: false }>;

/**
 * "Send to connected systems" (docs/spec.md "Webhooks", Consent): the owner
 * lets the meeting go to the install's endpoints whatever its visibility,
 * and its current state goes at once. Consent is a value, so a second press
 * changes nothing; the dedupe keys stop it sending the same transcript or
 * version twice. Setting the meeting to private takes the consent back.
 */
export async function sendToConnected(meetingId: string): Promise<SendResult> {
  let sent: { queued: number; transcript: boolean; recap: boolean } = {
    queued: 0,
    transcript: false,
    recap: false,
  };
  const result = await outcome(() =>
    asOwner(meetingId, async ({ db, installId, queue }) => {
      await db
        .update(m)
        .set({ webhookConsentAt: sql`coalesce(${m.webhookConsentAt}, ${Date.now()})` })
        .where(thisMeeting(meetingId, installId));
      sent = await queueCurrentState({ db, installId, queue }, meetingId);
    }),
  );
  return result.ok ? { ok: true, ...sent } : result;
}
