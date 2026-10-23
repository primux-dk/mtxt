import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Db, type Transcript } from '@mtxt/adapters';
import { unnamedNumber } from '../transcription/speakers';

/** A speaker as the transcript tab shows it. */
export interface SpeakerView {
  id: string;
  /** The stored label. "Speaker n" (unnamed) is shown in the reader's language. */
  label: string;
  /** The number in "Speaker n", or null when the speaker has a name. */
  unnamed: number | null;
  user: { id: string; name: string; email: string } | null;
}

/** start ms, end ms, speaker id, text: compact, since a 4-hour meeting has thousands. */
export type SegmentTuple = [number, number, string | null, string];

export interface TranscriptView {
  transcript: Transcript;
  speakers: SpeakerView[];
  segments: SegmentTuple[];
}

const s = schema.speakers;
const u = schema.users;

/** The meeting's speakers, with the colleague each one is linked to. */
export async function meetingSpeakers(
  db: Db,
  installId: string,
  meetingId: string,
): Promise<SpeakerView[]> {
  const rows = await db
    .select({
      id: s.id,
      label: s.label,
      userId: u.id,
      userName: u.name,
      userEmail: u.email,
    })
    .from(s)
    .leftJoin(u, and(eq(u.id, s.userId), eq(u.installId, installId)))
    .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)))
    .orderBy(sql`coalesce(${s.speakerIndex}, 1000000)`, asc(s.label));
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    unnamed: row.userId ? null : unnamedNumber(row.label),
    user: row.userId ? { id: row.userId, name: row.userName!, email: row.userEmail! } : null,
  }));
}

/**
 * A recording's transcript for the tab: the row, the meeting's speakers and
 * the segments in time order. Comparison transcripts are never read here.
 */
export async function loadTranscript(
  db: Db,
  installId: string,
  meetingId: string,
  recordingId: string,
): Promise<TranscriptView | null> {
  const transcript = await db.query.transcripts.findFirst({
    where: and(
      eq(schema.transcripts.installId, installId),
      eq(schema.transcripts.recordingId, recordingId),
      eq(schema.transcripts.isComparison, false),
    ),
  });
  if (!transcript) return null;
  const [speakers, segments] = await Promise.all([
    meetingSpeakers(db, installId, meetingId),
    transcript.status === 'done'
      ? db
          .select({
            startMs: schema.segments.startMs,
            endMs: schema.segments.endMs,
            speakerId: schema.segments.speakerId,
            text: schema.segments.text,
          })
          .from(schema.segments)
          .where(
            and(
              eq(schema.segments.installId, installId),
              eq(schema.segments.transcriptId, transcript.id),
            ),
          )
          .orderBy(asc(schema.segments.startMs), asc(schema.segments.id))
      : Promise.resolve([]),
  ]);
  return {
    transcript,
    speakers,
    segments: segments.map((g) => [g.startMs, g.endMs, g.speakerId, g.text]),
  };
}
