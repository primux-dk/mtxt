'use server';

import { and, eq, isNotNull } from 'drizzle-orm';
import { foldTitle, schema } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { HttpError } from '@/lib/http-error';
import { getAdapters } from '@/lib/install';
import { assertOwnRowsOnly, deleteMeetingRows } from '@/lib/meetings/integrity';
import { accessTo } from '@/lib/meetings/queries';

/**
 * The owner's changes to a meeting. Each sets a value rather than toggling
 * one, so a retry never doubles a change (behaviour.md rule 2). Each answers
 * with the outcome; the screen rolls back on `ok: false`.
 */
export type ActionResult =
  { ok: true } | { ok: false; code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'server' };

const m = schema.meetings;
const r = schema.recordings;
const thisMeeting = (meetingId: string, installId: string) =>
  and(eq(m.id, meetingId), eq(m.installId, installId));

async function asOwner<T>(
  meetingId: string,
  run: (ctx: Awaited<ReturnType<typeof getAdapters>>) => Promise<T>,
) {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
  const ctx = await getAdapters();
  const meeting = await ctx.db.query.meetings.findFirst({
    where: and(eq(m.id, meetingId), eq(m.installId, ctx.installId)),
  });
  const access = meeting ? await accessTo(ctx.db, ctx.installId, meeting, user) : null;
  if (!access) throw new HttpError(404, 'not_found', 'No such meeting.');
  if (access !== 'owner')
    throw new HttpError(403, 'forbidden', 'Only the owner changes a meeting.');
  return run(ctx);
}

async function outcome(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 403 || error.status === 401) return { ok: false, code: 'forbidden' };
      if (error.status === 404) return { ok: false, code: 'not_found' };
      if (error.status === 400) return { ok: false, code: 'invalid' };
      if (error.status === 409) return { ok: false, code: 'conflict' };
    }
    console.error(error);
    return { ok: false, code: 'server' };
  }
}

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
 * install's rows depend on it (lib/meetings/integrity.ts). Otherwise open
 * uploads are aborted, every recording's audio is deleted from storage, then
 * the rows, table by table and by install, in one transaction. Storage goes
 * first, so a failure leaves the meeting in place to delete again, never
 * orphaned audio.
 */
export async function deleteMeeting(meetingId: string): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, storage, uploads, installId }) => {
      await assertOwnRowsOnly(db, installId, meetingId);
      const recordings = await db.query.recordings.findMany({
        where: and(eq(r.meetingId, meetingId), eq(r.installId, installId)),
      });
      await Promise.all(
        recordings
          .filter((rec) => rec.status === 'uploading')
          .map((rec) => uploads.get(rec.id).abort()),
      );
      const recap = await db.query.recaps.findFirst({
        where: and(eq(schema.recaps.meetingId, meetingId), eq(schema.recaps.installId, installId)),
      });
      const keys = [
        ...recordings.map((rec) => rec.storagePath),
        ...(recap?.docxPath ? [recap.docxPath] : []),
      ];
      if (keys.length) await storage.delete(keys);
      await deleteMeetingRows(db, installId, meetingId);
    }),
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
      const [updated] = await db
        .update(r)
        .set({ status: 'transcribing', failure: null })
        .where(
          and(
            eq(r.id, recordingId),
            eq(r.installId, installId),
            eq(r.meetingId, meetingId),
            eq(r.status, 'failed'),
            isNotNull(r.confirmedAt),
          ),
        )
        .returning({ id: r.id });
      // Already queued by an earlier click: nothing to do, and no second job.
      if (!updated) return;
      try {
        await queue.send({ type: 'transcribe', recording_id: recordingId, install_id: installId });
      } catch (error) {
        await db
          .update(r)
          .set({ status: 'failed' })
          .where(and(eq(r.id, recordingId), eq(r.installId, installId)));
        throw error;
      }
    }),
  );
}
