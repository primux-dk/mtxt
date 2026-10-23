import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { StorageAdapter } from '../storage';
import type { Db } from './index';
import { foreignRowsSql } from './integrity';
import * as schema from './schema';
import { storageCleanup } from './schema';
import type { Settings } from './schema';
import { meetingKey, meetingSearch } from './search';
import { finishCleanup } from './storage-cleanup';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A deletion is announced on the meeting page this long ahead (behaviour.md rule 3). */
export const RETENTION_NOTICE_DAYS = 7;
/** Meetings per retention job; a full batch queues the next one. */
export const RETENTION_BATCH = 100;

type RetentionSettings = Pick<Settings, 'retentionAudioDays' | 'retentionTranscriptDays'>;

/** When a meeting's audio, and its transcripts and recap, fall due. Both count from `started_at`. */
export function retentionDeadlines(startedAt: Date, settings: RetentionSettings) {
  const start = startedAt.getTime();
  return {
    audio: new Date(start + settings.retentionAudioDays * DAY_MS),
    text: new Date(start + settings.retentionTranscriptDays * DAY_MS),
  };
}

export interface RetentionNotice {
  /** What goes: the audio, the transcripts and recap, or everything that is left. */
  kind: 'audio' | 'text' | 'all';
  /** The earliest deadline inside the notice window. */
  at: Date;
  /** The deadline has passed and the next nightly run takes it. */
  overdue: boolean;
}

/**
 * The notice the meeting page shows, or null. Only for a meeting without
 * `keep`, and only when a deadline for something it still has is at most
 * RETENTION_NOTICE_DAYS away. A meeting with nothing left to delete is
 * announced for the later deadline, when its row is marked deleted.
 */
export function retentionNotice(
  meeting: { startedAt: Date; keep: boolean; deletedAt: Date | null },
  settings: RetentionSettings,
  has: { audio: boolean; text: boolean },
  now = new Date(),
): RetentionNotice | null {
  if (meeting.keep || meeting.deletedAt) return null;
  const due = retentionDeadlines(meeting.startedAt, settings);
  const horizon = now.getTime() + RETENTION_NOTICE_DAYS * DAY_MS;
  const within = (d: Date) => d.getTime() <= horizon;
  const audio = has.audio && within(due.audio) ? due.audio : null;
  const text = has.text && within(due.text) ? due.text : null;
  let kind: RetentionNotice['kind'];
  let at: Date;
  if (audio && text) [kind, at] = ['all', audio < text ? audio : text];
  else if (audio) [kind, at] = has.text ? ['audio', audio] : ['all', audio];
  else if (text) [kind, at] = has.audio ? ['text', text] : ['all', text];
  else if (!has.audio && !has.text) {
    const last = due.audio > due.text ? due.audio : due.text;
    if (!within(last)) return null;
    [kind, at] = ['all', last];
  } else return null;
  return { kind, at, overdue: at.getTime() <= now.getTime() };
}

/** Why a meeting past a deadline was left alone. `changed` means it stopped qualifying between selection and deletion, for example a Keep. */
export type RetentionSkipReason = 'keep' | 'open_upload' | 'foreign_rows' | 'changed';

export interface RetentionResult {
  /** Meetings this batch selected. */
  meetings: number;
  audioDeleted: number;
  textDeleted: number;
  /** Meetings whose audio and transcript are both gone, now marked deleted. */
  markedDeleted: number;
  /** Meetings past a deadline that were left alone, with the reason; ids only. */
  skipped: { id: string; reason: RetentionSkipReason }[];
  /** The batch was full: queue another. */
  more: boolean;
}

/**
 * One batch of retention for one install, as of `now`. Picks up to `limit`
 * meetings without `keep` that have something past its deadline:
 *
 * - audio past `retention_audio_days`: `storage_path` is cleared and
 *   `delete_audio_at` records when, then the objects go from storage;
 * - past `retention_transcript_days`: segments, transcripts, recaps,
 *   versions, decisions and their search rows, then the recaps' docx and
 *   images;
 * - past both: the meeting keeps its row, with `deleted_at` set.
 *
 * Every write carries the whole eligibility in its WHERE (no `keep`, not
 * deleted, the deadline passed, no upload open, no rows of another install),
 * so a Keep set after selection wins. Storage is deleted only for the rows
 * that write changed; if the audio delete fails, the paths are put back
 * for the next try. With `reportSkips`, every meeting past a deadline that
 * is left alone is listed with the reason, paged, never cut off.
 */
export async function retentionBatch(
  ctx: { db: Db; storage: Pick<StorageAdapter, 'delete'>; installId: string },
  settings: RetentionSettings,
  now: Date,
  limit = RETENTION_BATCH,
  options: { reportSkips?: boolean } = {},
): Promise<RetentionResult> {
  const { db, storage, installId } = ctx;
  const t = now.getTime();
  const audioCutoff = t - settings.retentionAudioDays * DAY_MS;
  const textCutoff = t - settings.retentionTranscriptDays * DAY_MS;
  const bothCutoff = Math.min(audioCutoff, textCutoff);

  const uploading = (meeting: SQL) => sql`exists (select 1 from recordings u
    where u.install_id = ${installId} and u.meeting_id = ${meeting} and u.status = 'uploading')`;
  /** The meeting may lose what falls due at `cutoff`, checked inside the statement that deletes. */
  const eligible = (meetingId: string, cutoff: number) => sql`exists (select 1 from meetings g
    where g.id = ${meetingId} and g.install_id = ${installId} and g.keep = 0
      and g.deleted_at is null and g.started_at <= ${cutoff}
      and not ${uploading(sql`g.id`)}
      and ${foreignRowsSql(installId, sql`g.id`)} = 0)`;

  const hasAudio = sql`exists (select 1 from recordings r where r.install_id = ${installId}
    and r.meeting_id = m.id and r.storage_path != '')`;
  const hasText = sql`(exists (select 1 from transcripts tr join recordings r on r.id = tr.recording_id
      where tr.install_id = ${installId} and r.install_id = ${installId} and r.meeting_id = m.id)
    or exists (select 1 from recaps c where c.install_id = ${installId} and c.meeting_id = m.id)
    or exists (select 1 from recap_images i where i.install_id = ${installId} and i.meeting_id = m.id))`;
  const due = sql`m.install_id = ${installId} and m.deleted_at is null
      and m.started_at <= ${Math.max(audioCutoff, textCutoff)}
      and ((m.started_at <= ${audioCutoff} and ${hasAudio})
        or (m.started_at <= ${textCutoff} and ${hasText})
        or m.started_at <= ${bothCutoff})`;

  const picked = await db.all<{ id: string; started_at: number; audio: number; text: number }>(sql`
    select m.id, m.started_at, ${hasAudio} as audio, ${hasText} as text
    from meetings m
    where ${due} and m.keep = 0 and not ${uploading(sql`m.id`)}
      and ${foreignRowsSql(installId, sql`m.id`)} = 0
    order by m.started_at, m.id
    limit ${limit}`);

  const result: RetentionResult = {
    meetings: picked.length,
    audioDeleted: 0,
    textDeleted: 0,
    markedDeleted: 0,
    skipped: [],
    more: picked.length === limit,
  };

  if (options.reportSkips) {
    // Every skipped meeting, a page of RETENTION_BATCH at a time, oldest first.
    let after: { started_at: number; id: string } | null = null;
    for (;;) {
      const page: { id: string; started_at: number; reason: RetentionSkipReason }[] =
        await db.all(sql`
        select m.id, m.started_at, case when m.keep = 1 then 'keep'
          when ${uploading(sql`m.id`)} then 'open_upload' else 'foreign_rows' end as reason
        from meetings m
        where ${due} and (m.keep = 1 or ${uploading(sql`m.id`)}
          or ${foreignRowsSql(installId, sql`m.id`)} > 0)
          ${after ? sql`and (m.started_at, m.id) > (${after.started_at}, ${after.id})` : sql``}
        order by m.started_at, m.id
        limit ${RETENTION_BATCH}`);
      result.skipped.push(...page.map(({ id, reason }) => ({ id, reason })));
      if (page.length < RETENTION_BATCH) break;
      after = page.at(-1)!;
    }
  }

  for (const meeting of picked) {
    const started = Number(meeting.started_at);
    let touched = false;

    if (started <= audioCutoff && Number(meeting.audio)) {
      const recs = await db.all<{ id: string; storage_path: string }>(sql`
        select id, storage_path from recordings
        where install_id = ${installId} and meeting_id = ${meeting.id} and storage_path != ''`);
      const path = new Map(recs.map((r) => [r.id, r.storage_path]));
      const claimed = recs.length
        ? await db.all<{
            id: string;
          }>(sql`update recordings set storage_path = '', delete_audio_at = ${t}
            where install_id = ${installId} and meeting_id = ${meeting.id} and storage_path != ''
              and id in (${sql.join(
                recs.map((r) => sql`${r.id}`),
                sql`, `,
              )})
              and ${eligible(meeting.id, audioCutoff)}
            returning id`)
        : [];
      if (claimed.length) {
        try {
          await storage.delete(claimed.map((r) => path.get(r.id)!));
        } catch (error) {
          // The objects may still be there: put the paths back, so the retry finds them.
          for (const r of claimed) {
            await db.run(sql`update recordings set storage_path = ${path.get(r.id)!}, delete_audio_at = null
              where install_id = ${installId} and id = ${r.id} and storage_path = ''`);
          }
          throw error;
        }
        result.audioDeleted++;
        touched = true;
      }
    }

    if (started <= textCutoff && Number(meeting.text)) {
      // What the transcript batch takes along in storage: the recaps' docx and images, and the
      // providers' raw results (transcripts.raw_path), comparison transcripts included.
      const objects = await db.all<{ path: string }>(sql`
        select docx_path as path from recaps where install_id = ${installId}
          and meeting_id = ${meeting.id} and docx_path is not null
        union
        select t.raw_path from transcripts t
          join recordings r on r.id = t.recording_id and r.install_id = ${installId}
          where t.install_id = ${installId} and r.meeting_id = ${meeting.id} and t.raw_path is not null
        union
        select path from recap_images where install_id = ${installId} and meeting_id = ${meeting.id}`);
      const guard = eligible(meeting.id, textCutoff);
      // One cleanup entry per object, written in the batch only if the guard lets the rows go.
      const cleanup = objects.map((o) => ({ id: crypto.randomUUID(), path: o.path }));
      const recordObjects = cleanup.map((e) =>
        db.insert(storageCleanup).select(
          db
            .select({
              id: sql<string>`${e.id}`.as('id'),
              installId: schema.meetings.installId,
              path: sql<string>`${e.path}`.as('path'),
              createdAt: sql<number>`${t}`.as('created_at'),
              attempts: sql<number>`0`.as('attempts'),
            })
            .from(schema.meetings)
            .where(
              and(
                eq(schema.meetings.id, meeting.id),
                eq(schema.meetings.installId, installId),
                guard,
              ),
            ),
        ),
      );
      const recs = db
        .select({ id: schema.recordings.id })
        .from(schema.recordings)
        .where(
          and(
            eq(schema.recordings.installId, installId),
            eq(schema.recordings.meetingId, meeting.id),
          ),
        );
      const trs = db
        .select({ id: schema.transcripts.id })
        .from(schema.transcripts)
        .where(
          and(
            eq(schema.transcripts.installId, installId),
            inArray(schema.transcripts.recordingId, recs),
          ),
        );
      const caps = db
        .select({ id: schema.recaps.id })
        .from(schema.recaps)
        .where(
          and(eq(schema.recaps.installId, installId), eq(schema.recaps.meetingId, meeting.id)),
        );
      const deletes = [
        db
          .update(schema.recaps)
          .set({ currentVersionId: null })
          .where(and(inArray(schema.recaps.id, caps), guard)),
        db
          .delete(schema.decisions)
          .where(
            and(
              eq(schema.decisions.installId, installId),
              inArray(schema.decisions.recapId, caps),
              guard,
            ),
          ),
        db
          .delete(schema.recapVersions)
          .where(
            and(
              eq(schema.recapVersions.installId, installId),
              inArray(schema.recapVersions.recapId, caps),
              guard,
            ),
          ),
        db
          .delete(schema.recaps)
          .where(
            and(
              eq(schema.recaps.installId, installId),
              eq(schema.recaps.meetingId, meeting.id),
              guard,
            ),
          )
          .returning({ id: schema.recaps.id }),
        db
          .delete(schema.segments)
          .where(
            and(
              eq(schema.segments.installId, installId),
              inArray(schema.segments.transcriptId, trs),
              guard,
            ),
          ),
        db
          .delete(schema.transcripts)
          .where(
            and(
              eq(schema.transcripts.installId, installId),
              inArray(schema.transcripts.recordingId, recs),
              guard,
            ),
          )
          .returning({ id: schema.transcripts.id }),
        db
          .delete(meetingSearch)
          .where(
            and(
              sql`meeting_search match ${`meeting_key : "${meetingKey(meeting.id)}"`}`,
              eq(meetingSearch.installId, installId),
              inArray(meetingSearch.kind, ['segment', 'recap']),
              guard,
            ),
          ),
        // The recap's images, with or without a recap or a transcript left.
        db
          .delete(schema.recapImages)
          .where(
            and(
              eq(schema.recapImages.installId, installId),
              eq(schema.recapImages.meetingId, meeting.id),
              guard,
            ),
          ),
      ] as const;
      // Recorded first: the inserts read the recaps the deletes then remove.
      const results = (await db.batch([...recordObjects, ...deletes] as unknown as Parameters<
        typeof db.batch
      >[0])) as unknown as unknown[];
      const gone = results[recordObjects.length + 3] as { id: string }[];
      const dropped = results[recordObjects.length + 5] as { id: string }[];
      // The objects were recorded in the same batch, only if it let the rows go; delete them now.
      const recorded = cleanup.length
        ? await db
            .select({ id: storageCleanup.id, path: storageCleanup.path })
            .from(storageCleanup)
            .where(
              and(
                eq(storageCleanup.installId, installId),
                inArray(
                  storageCleanup.id,
                  cleanup.map((e) => e.id),
                ),
              ),
            )
        : [];
      if (recorded.length) await finishCleanup(db, storage, installId, recorded);
      if (gone.length || dropped.length) {
        result.textDeleted++;
        touched = true;
      }
    }

    if (started <= bothCutoff) {
      const marked = await db.all<{ id: string }>(sql`update meetings set deleted_at = ${t}
        where install_id = ${installId} and id = ${meeting.id} and deleted_at is null
          and ${eligible(meeting.id, bothCutoff)}
        returning id`);
      if (marked.length) {
        result.markedDeleted++;
        touched = true;
      }
    }

    if (!touched) result.skipped.push({ id: meeting.id, reason: 'changed' });
  }
  return result;
}
