import { and, eq, inArray, sql } from 'drizzle-orm';
import type { StorageAdapter } from '../storage';
import type { Db } from './index';
import { foreignRowsSql } from './integrity';
import * as schema from './schema';
import type { Settings } from './schema';
import { dropFromSearchStatement } from './search';

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

export interface RetentionResult {
  /** Meetings this batch looked at. */
  meetings: number;
  audioDeleted: number;
  textDeleted: number;
  /** Meetings whose audio and transcript are both gone, now marked deleted. */
  markedDeleted: number;
  /** The batch was full: queue another. */
  more: boolean;
}

/**
 * One batch of retention for one install, as of `now`. Picks up to `limit`
 * meetings without `keep` that have something past its deadline:
 *
 * - audio past `retention_audio_days`: the objects go from storage, then
 *   `storage_path` is cleared and `delete_audio_at` records when;
 * - past `retention_transcript_days`: segments, transcripts, recaps (and
 *   their docx), versions and decisions, and their search rows;
 * - past both: the meeting keeps its row, with `deleted_at` set.
 *
 * A meeting with an upload still open, or with rows of another install
 * under it, is left for a later night. Every meeting it touches leaves the
 * selection, so batches end. Storage goes before rows, so a failure leaves
 * rows to try again, never orphaned audio.
 */
export async function retentionBatch(
  ctx: { db: Db; storage: Pick<StorageAdapter, 'delete'>; installId: string },
  settings: RetentionSettings,
  now: Date,
  limit = RETENTION_BATCH,
): Promise<RetentionResult> {
  const { db, storage, installId } = ctx;
  const t = now.getTime();
  const audioCutoff = t - settings.retentionAudioDays * DAY_MS;
  const textCutoff = t - settings.retentionTranscriptDays * DAY_MS;
  const bothCutoff = Math.min(audioCutoff, textCutoff);

  const hasAudio = sql`exists (select 1 from recordings r where r.install_id = ${installId}
    and r.meeting_id = m.id and r.storage_path != '')`;
  const hasText = sql`(exists (select 1 from transcripts tr join recordings r on r.id = tr.recording_id
      where tr.install_id = ${installId} and r.install_id = ${installId} and r.meeting_id = m.id)
    or exists (select 1 from recaps c where c.install_id = ${installId} and c.meeting_id = m.id))`;

  const picked = await db.all<{ id: string; started_at: number; audio: number; text: number }>(sql`
    select m.id, m.started_at, ${hasAudio} as audio, ${hasText} as text
    from meetings m
    where m.install_id = ${installId} and m.keep = 0 and m.deleted_at is null
      and m.started_at <= ${Math.max(audioCutoff, textCutoff)}
      and ((m.started_at <= ${audioCutoff} and ${hasAudio})
        or (m.started_at <= ${textCutoff} and ${hasText})
        or m.started_at <= ${bothCutoff})
      and not exists (select 1 from recordings r where r.install_id = ${installId}
        and r.meeting_id = m.id and r.status = 'uploading')
      and ${foreignRowsSql(installId, sql`m.id`)} = 0
    order by m.started_at, m.id
    limit ${limit}`);

  const result: RetentionResult = {
    meetings: picked.length,
    audioDeleted: 0,
    textDeleted: 0,
    markedDeleted: 0,
    more: picked.length === limit,
  };

  for (const meeting of picked) {
    const started = Number(meeting.started_at);
    if (started <= audioCutoff && Number(meeting.audio)) {
      const recs = await db.all<{ id: string; storage_path: string }>(sql`
        select id, storage_path from recordings
        where install_id = ${installId} and meeting_id = ${meeting.id} and storage_path != ''`);
      if (recs.length) {
        await storage.delete(recs.map((r) => r.storage_path));
        await db.run(sql`update recordings set storage_path = '', delete_audio_at = ${t}
          where install_id = ${installId} and meeting_id = ${meeting.id} and storage_path != ''`);
        result.audioDeleted++;
      }
    }

    if (started <= textCutoff && Number(meeting.text)) {
      const docx = await db.all<{ docx_path: string }>(sql`
        select docx_path from recaps where install_id = ${installId}
          and meeting_id = ${meeting.id} and docx_path is not null`);
      if (docx.length) await storage.delete(docx.map((d) => d.docx_path));
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
      await db.batch([
        db
          .update(schema.recaps)
          .set({ currentVersionId: null })
          .where(inArray(schema.recaps.id, caps)),
        db
          .delete(schema.decisions)
          .where(
            and(eq(schema.decisions.installId, installId), inArray(schema.decisions.recapId, caps)),
          ),
        db
          .delete(schema.recapVersions)
          .where(
            and(
              eq(schema.recapVersions.installId, installId),
              inArray(schema.recapVersions.recapId, caps),
            ),
          ),
        db
          .delete(schema.recaps)
          .where(
            and(eq(schema.recaps.installId, installId), eq(schema.recaps.meetingId, meeting.id)),
          ),
        db
          .delete(schema.segments)
          .where(
            and(
              eq(schema.segments.installId, installId),
              inArray(schema.segments.transcriptId, trs),
            ),
          ),
        db
          .delete(schema.transcripts)
          .where(
            and(
              eq(schema.transcripts.installId, installId),
              inArray(schema.transcripts.recordingId, recs),
            ),
          ),
        dropFromSearchStatement(db, installId, meeting.id, ['segment', 'recap']),
      ]);
      result.textDeleted++;
    }

    if (started <= bothCutoff) {
      await db.run(sql`update meetings set deleted_at = ${t}
        where install_id = ${installId} and id = ${meeting.id} and deleted_at is null`);
      result.markedDeleted++;
    }
  }
  return result;
}
