import { and, asc, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '@mtxt/adapters';

/** The transcript a signed `transcript` link answers with (docs/spec.md "Webhooks", Links). */
export interface TranscriptExport {
  meeting_id: string;
  language: string;
  speakers: { id: string; name: string }[];
  segments: { start_ms: number; end_ms: number; speaker_id: string | null; text: string }[];
}

/**
 * The meeting's transcript: the primary recording's done one, else the
 * newest done one; never a comparison transcript. Speakers by the linked
 * colleague's name, else their label. Null when there is none.
 */
export async function transcriptExport(
  db: Db,
  installId: string,
  meetingId: string,
): Promise<TranscriptExport | null> {
  const t = schema.transcripts;
  const r = schema.recordings;
  const row = await db
    .select({ id: t.id, language: t.language })
    .from(t)
    .innerJoin(r, and(eq(r.id, t.recordingId), eq(r.installId, installId)))
    .where(
      and(
        eq(t.installId, installId),
        eq(r.meetingId, meetingId),
        eq(t.status, 'done'),
        eq(t.isComparison, false),
      ),
    )
    .orderBy(desc(r.isPrimary), desc(t.createdAt))
    .get();
  if (!row) return null;
  const s = schema.speakers;
  const u = schema.users;
  const g = schema.segments;
  const [speakers, segments] = await Promise.all([
    db
      .select({ id: s.id, label: s.label, userName: u.name })
      .from(s)
      .leftJoin(u, and(eq(u.id, s.userId), eq(u.installId, installId)))
      .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId))),
    db
      .select({ startMs: g.startMs, endMs: g.endMs, speakerId: g.speakerId, text: g.text })
      .from(g)
      .where(and(eq(g.installId, installId), eq(g.transcriptId, row.id)))
      .orderBy(asc(g.startMs), asc(g.id)),
  ]);
  return {
    meeting_id: meetingId,
    language: row.language,
    speakers: speakers.map((sp) => ({ id: sp.id, name: sp.userName ?? sp.label })),
    segments: segments.map((seg) => ({
      start_ms: seg.startMs,
      end_ms: seg.endMs,
      speaker_id: seg.speakerId,
      text: seg.text,
    })),
  };
}
