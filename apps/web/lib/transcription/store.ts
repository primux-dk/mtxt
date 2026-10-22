/*
  The transcription rows: the transcript, the meeting's speakers, the
  segments and the recording's status. Every statement carries install_id.
*/
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db, type Transcript } from '@mtxt/adapters';
import type { SttFailure, SttResult } from '../stt/types';
import { planSpeakers } from './speakers';

const t = schema.transcripts;
const r = schema.recordings;
const s = schema.speakers;
const g = schema.segments;

/** The recording's own transcript (never a comparison). */
export async function primaryTranscript(db: Db, installId: string, recordingId: string) {
  return (
    (await db.query.transcripts.findFirst({
      where: and(
        eq(t.installId, installId),
        eq(t.recordingId, recordingId),
        eq(t.isComparison, false),
      ),
      orderBy: [desc(t.createdAt)],
    })) ?? null
  );
}

/**
 * The pending row a submit writes first. An existing pending or failed row
 * is taken over (a retry, or Try again), so a recording keeps one row.
 */
export async function claimTranscript(
  db: Db,
  installId: string,
  recordingId: string,
  provider: string,
  model: string,
): Promise<Transcript> {
  await db
    .insert(t)
    .values({
      installId,
      recordingId,
      provider,
      model,
      language: '',
      rawJson: {},
      status: 'pending',
    })
    .onConflictDoNothing();
  const row = await primaryTranscript(db, installId, recordingId);
  if (!row) throw new Error('The transcript row was not written.');
  if (row.status === 'done') return row;
  const [updated] = await db
    .update(t)
    .set({ provider, model, status: 'pending', providerJobId: null, rawJson: {}, language: '' })
    .where(and(eq(t.id, row.id), eq(t.installId, installId)))
    .returning();
  return updated!;
}

export async function setJobId(db: Db, installId: string, transcriptId: string, handle: string) {
  await db
    .update(t)
    .set({ providerJobId: handle })
    .where(and(eq(t.id, transcriptId), eq(t.installId, installId)));
}

export async function markTranscribing(db: Db, installId: string, recordingId: string) {
  await db
    .update(r)
    .set({ status: 'transcribing' })
    .where(and(eq(r.id, recordingId), eq(r.installId, installId), eq(r.status, 'confirmed')));
}

/** A transcription failure: the reason on the recording, the row marked failed. Audio is kept. */
export async function markFailed(
  db: Db,
  installId: string,
  recordingId: string,
  transcriptId: string | null,
  code: SttFailure,
  reason: string,
) {
  await db.batch([
    db
      .update(r)
      .set({ status: 'failed', failure: code, failureReason: reason.slice(0, 500) })
      .where(
        and(
          eq(r.id, recordingId),
          eq(r.installId, installId),
          inArray(r.status, ['confirmed', 'transcribing']),
        ),
      ),
    ...(transcriptId
      ? [
          db
            .update(t)
            .set({ status: 'failed' })
            .where(
              and(eq(t.id, transcriptId), eq(t.installId, installId), eq(t.status, 'pending')),
            ),
        ]
      : []),
  ]);
}

/** D1 holds a bound value to about 2 MB; segments go in as JSON arrays well under that. */
const SEGMENT_JSON_BYTES = 400_000;

/**
 * Writes a finished result: the meeting's speakers (reused by number), the
 * segments, and the transcript row as done, in one batch so a reader never
 * sees half a transcript. Segments the row had are replaced, so running it
 * twice gives the same rows.
 */
export async function writeResult(
  db: Db,
  installId: string,
  meetingId: string,
  transcriptId: string,
  result: SttResult,
) {
  const existing = await db
    .select({ id: s.id, speakerIndex: s.speakerIndex })
    .from(s)
    .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)));
  const plan = planSpeakers(existing, result.speakers);
  if (plan.create.length) {
    // ON CONFLICT DO NOTHING: a run that raced this one wrote the same speaker first.
    for (let i = 0; i < plan.create.length; i += 20) {
      await db
        .insert(s)
        .values(
          plan.create
            .slice(i, i + 20)
            .map((c) => ({ installId, meetingId, label: c.label, speakerIndex: c.speakerIndex })),
        )
        .onConflictDoNothing();
    }
    const rows = await db
      .select({ id: s.id, speakerIndex: s.speakerIndex })
      .from(s)
      .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)));
    for (const row of rows) {
      if (row.speakerIndex !== null && !plan.reuse.has(row.speakerIndex)) {
        plan.reuse.set(row.speakerIndex, row.id);
      }
    }
  }

  const batches: string[] = [];
  let current: unknown[] = [];
  let size = 2;
  for (const seg of result.segments) {
    const row = [
      crypto.randomUUID(),
      plan.reuse.get(seg.speaker) ?? null,
      seg.startMs,
      Math.max(seg.endMs, seg.startMs),
      seg.text,
    ];
    const length = JSON.stringify(row).length + 1;
    if (current.length && size + length > SEGMENT_JSON_BYTES) {
      batches.push(JSON.stringify(current));
      current = [];
      size = 2;
    }
    current.push(row);
    size += length;
  }
  if (current.length) batches.push(JSON.stringify(current));

  await db.batch([
    db.delete(g).where(and(eq(g.installId, installId), eq(g.transcriptId, transcriptId))),
    ...batches.map((json) =>
      db.run(sql`insert into segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text)
        select json_extract(value, '$[0]'), ${installId}, ${transcriptId}, json_extract(value, '$[1]'),
          json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]')
        from json_each(${json})`),
    ),
    db
      .update(t)
      .set({
        status: 'done',
        language: result.language,
        model: result.model,
        rawJson: result.raw ?? {},
      })
      .where(and(eq(t.id, transcriptId), eq(t.installId, installId))),
  ]);
}

/** The last step: the recording is ready. Only from confirmed or transcribing. */
export async function markTranscribed(db: Db, installId: string, recordingId: string) {
  const updated = await db
    .update(r)
    .set({ status: 'transcribed', failure: null, failureReason: null })
    .where(
      and(
        eq(r.id, recordingId),
        eq(r.installId, installId),
        inArray(r.status, ['confirmed', 'transcribing']),
      ),
    )
    .returning({ id: r.id });
  return updated.length > 0;
}
