/*
  The transcription rows: the transcript, the meeting's speakers, the
  segments and the recording's status. Every statement carries install_id.

  Concurrency (docs/decisions.md, packet 4 review): a delivery claims the
  transcript row with one conditional UPDATE and a fresh token; every later
  write by that delivery names the token, so a second delivery, or a late
  one whose claim expired, cannot write over it. A terminal row (done,
  failed) is never claimed.
*/
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import {
  meetingSegments,
  schema,
  syncSearch,
  type Db,
  type Job,
  type StorageAdapter,
  type Transcript,
} from '@mtxt/adapters';
import { SttError, type SttFailure, type SttResult } from '../stt/types';
import { planSpeakers } from './speakers';

const t = schema.transcripts;
const r = schema.recordings;
const s = schema.speakers;
const g = schema.segments;

/** A claim lapses after this: the upload's 10 minutes plus room. A held delivery waits it out. */
export const CLAIM_LEASE_MS = 15 * 60_000;
/** How long the provider may keep an async job before the attempt fails as a timeout. */
export const POLL_DEADLINE_MS = 6 * 3600_000;
/** An outbox row left unsent this long is sent again by the next delivery. */
export const OUTBOX_RESEND_MS = 60_000;
/** D1 keeps a value to 2,000,000 bytes; nothing the pipeline writes comes near it. */
export const MAX_D1_VALUE_BYTES = 1_900_000;
/** Segments go in as JSON arrays of at most this many bytes per statement. */
const SEGMENT_JSON_BYTES = 400_000;

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Refuses a value D1 would refuse in production (local D1 does not check). */
export function boundD1(value: string, what: string): string {
  if (bytes(value) > MAX_D1_VALUE_BYTES) {
    throw new SttError('stt_failed', 'internal', false, undefined, `D1 value ${what}`);
  }
  return value;
}

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

/** The row a first submit needs; an existing row is left as it is. */
export async function ensureTranscript(
  db: Db,
  installId: string,
  recordingId: string,
  provider: string,
  model: string,
) {
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
}

const unclaimed = (now: Date) => or(isNull(t.claimExpiresAt), lt(t.claimExpiresAt, now));

/**
 * Claims the recording's pending transcript for this delivery: to submit
 * (no provider job yet) or to fetch (a job id is stored). One conditional
 * UPDATE; null when another delivery holds an unexpired claim or the row is
 * no longer pending.
 */
export async function claimTranscript(
  db: Db,
  installId: string,
  recordingId: string,
  mode: 'submit' | 'fetch',
  set: { provider?: string; model?: string } = {},
  now = new Date(),
): Promise<(Transcript & { claimToken: string }) | null> {
  const token = crypto.randomUUID();
  const [row] = await db
    .update(t)
    .set({
      ...set,
      claimedAt: now,
      claimToken: token,
      claimExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
    })
    .where(
      and(
        eq(t.installId, installId),
        eq(t.recordingId, recordingId),
        eq(t.isComparison, false),
        eq(t.status, 'pending'),
        mode === 'submit' ? isNull(t.providerJobId) : sql`${t.providerJobId} is not null`,
        unclaimed(now),
      ),
    )
    .returning();
  return row ? (row as Transcript & { claimToken: string }) : null;
}

/** When the live claim on the recording's transcript lapses, if another delivery holds one. */
export async function heldUntil(db: Db, installId: string, recordingId: string, now = new Date()) {
  const row = await primaryTranscript(db, installId, recordingId);
  if (row?.status !== 'pending' || !row.claimExpiresAt || row.claimExpiresAt <= now) return null;
  return row.claimExpiresAt;
}

const holds = (transcriptId: string, token: string) =>
  and(eq(t.id, transcriptId), eq(t.claimToken, token), eq(t.status, 'pending'));

const unclaim = { claimedAt: null, claimToken: null, claimExpiresAt: null } as const;

/**
 * Stores the provider's job id, starts the attempt's polling deadline and
 * lets the claim go, so the webhook's delivery can take it.
 */
export async function storeJobId(
  db: Db,
  installId: string,
  transcriptId: string,
  token: string,
  handle: string,
  now = new Date(),
) {
  const updated = await db
    .update(t)
    .set({
      providerJobId: boundD1(handle, 'provider_job_id'),
      pollDeadlineAt: new Date(now.getTime() + POLL_DEADLINE_MS),
      ...unclaim,
    })
    .where(and(eq(t.installId, installId), holds(transcriptId, token)))
    .returning({ id: t.id });
  return updated.length > 0;
}

/** Lets a claim go without a change (the provider is still working). */
export async function release(db: Db, installId: string, transcriptId: string, token: string) {
  await db
    .update(t)
    .set(unclaim)
    .where(and(eq(t.installId, installId), holds(transcriptId, token)));
}

export async function markTranscribing(db: Db, installId: string, recordingId: string) {
  await db
    .update(r)
    .set({ status: 'transcribing' })
    .where(and(eq(r.id, recordingId), eq(r.installId, installId), eq(r.status, 'confirmed')));
}

/**
 * A transcription failure: the code and the stored reason on the recording,
 * the row marked failed. With a claim, only the claiming delivery can do it.
 * Audio is kept.
 */
export async function markFailed(
  db: Db,
  installId: string,
  recordingId: string,
  claim: { transcriptId: string; token: string } | null,
  code: SttFailure,
  reason: string,
) {
  const stored = boundD1(reason.slice(0, 200), 'failure_reason');
  const failRow = claim
    ? db
        .update(t)
        // The provider's job goes with the attempt; Try again submits anew.
        .set({ status: 'failed', providerJobId: null, pollDeadlineAt: null, ...unclaim })
        .where(and(eq(t.installId, installId), holds(claim.transcriptId, claim.token)))
        .returning({ id: t.id })
    : null;
  const recording = db
    .update(r)
    .set({ status: 'failed', failure: code, failureReason: stored })
    .where(
      and(
        eq(r.id, recordingId),
        eq(r.installId, installId),
        inArray(r.status, ['confirmed', 'transcribing']),
        // With a claim, the row this delivery just failed must be the one it held.
        ...(claim
          ? [
              sql`exists (select 1 from transcripts x where x.id = ${claim.transcriptId}
                and x.install_id = ${installId} and x.status = 'failed')`,
            ]
          : []),
      ),
    );
  if (failRow) await db.batch([failRow, recording]);
  else await recording;
}

/**
 * `transcripts/{install}/{recording}/{provider}-{tag}.json`: the provider's
 * raw result, in storage, under a key no other delivery writes (the tag is
 * the claim token). Only the completion that wins publishes its key.
 */
export const rawPath = (installId: string, recordingId: string, provider: string, tag: string) =>
  `transcripts/${installId}/${recordingId}/${provider}-${tag}.json`;

/**
 * `transcripts/{install}/{recording}/{provider}-{tag}/`: a recording sent in
 * pieces (packet 18) keeps its plan and one raw result per piece under this
 * prefix, named by the claim that planned the attempt. It is the row's
 * `raw_path` from the plan on, so a delete or retention takes the pieces
 * along even while the transcript is still pending.
 */
export const piecePrefix = (
  installId: string,
  recordingId: string,
  provider: string,
  tag: string,
) => `transcripts/${installId}/${recordingId}/${provider}-${tag}/`;

/** Segment rows as JSON arrays under the per-statement size, each checked against D1's bound. */
function segmentBatches(result: SttResult, speakerIds: Map<number, string>): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const seg of result.segments) {
    const row = JSON.stringify([
      crypto.randomUUID(),
      speakerIds.get(seg.speaker) ?? null,
      seg.startMs,
      Math.max(seg.endMs, seg.startMs),
      seg.text,
    ]);
    boundD1(row, 'segment');
    const length = bytes(row) + 1;
    if (current.length && size + length > SEGMENT_JSON_BYTES) {
      batches.push(`[${current.join(',')}]`);
      current = [];
      size = 2;
    }
    current.push(row);
    size += length;
  }
  if (current.length) batches.push(`[${current.join(',')}]`);
  return batches.map((b) => boundD1(b, 'segment batch'));
}

/**
 * Writes a finished result for the delivery that holds the claim: the raw
 * result to storage under this claim's own key, the meeting's speakers
 * (reused by number), then in one D1 batch the segments, the row `done`
 * with its `raw_path`, the recording `transcribed` and the recap outbox
 * row. Every statement in the batch checks the claim, so a delivery that
 * lost it writes nothing, and removes its own object.
 */
export async function completeTranscript(
  db: Db,
  storage: StorageAdapter,
  installId: string,
  recording: { id: string; meetingId: string },
  claim: { transcriptId: string; token: string; provider: string },
  result: SttResult,
  /** A result stitched from pieces: its raw results are stored under this prefix already. */
  stored?: { rawPath: string },
): Promise<{ written: boolean }> {
  const path = stored?.rawPath ?? rawPath(installId, recording.id, claim.provider, claim.token);
  if (!stored) {
    await storage.put(path, JSON.stringify(result.raw ?? null), {
      contentType: 'application/json',
    });
  }

  const held = sql`exists (select 1 from transcripts x where x.id = ${claim.transcriptId}
    and x.install_id = ${installId} and x.claim_token = ${claim.token} and x.status = 'pending')`;

  // Speakers first: rows are per meeting and number, so a racing writer lands on the same rows.
  const existing = await db
    .select({ id: s.id, speakerIndex: s.speakerIndex })
    .from(s)
    .where(and(eq(s.installId, installId), eq(s.meetingId, recording.meetingId)));
  const plan = planSpeakers(existing, result.speakers);
  if (plan.create.length) {
    const json = boundD1(
      JSON.stringify(plan.create.map((c) => [crypto.randomUUID(), c.label, c.speakerIndex])),
      'speakers',
    );
    await db
      .insert(s)
      .select(
        sql`select json_extract(value, '$[0]'), ${installId}, ${recording.meetingId},
          json_extract(value, '$[1]'), null, json_extract(value, '$[2]')
          from json_each(${json}) where ${held}`,
      )
      .onConflictDoNothing();
    const rows = await db
      .select({ id: s.id, speakerIndex: s.speakerIndex })
      .from(s)
      .where(and(eq(s.installId, installId), eq(s.meetingId, recording.meetingId)));
    for (const row of rows) {
      if (row.speakerIndex !== null && !plan.reuse.has(row.speakerIndex)) {
        plan.reuse.set(row.speakerIndex, row.id);
      }
    }
  }

  const results = await db.batch([
    db
      .delete(g)
      .where(and(eq(g.installId, installId), eq(g.transcriptId, claim.transcriptId), held)),
    ...segmentBatches(result, plan.reuse).map((json) =>
      db.insert(g).select(
        sql`select json_extract(value, '$[0]'), ${installId}, ${claim.transcriptId},
          json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
          json_extract(value, '$[4]')
          from json_each(${json}) where ${held}`,
      ),
    ),
    // The outbox row before the status flips, while the claim still shows as pending.
    db
      .insert(schema.recapOutbox)
      .select(
        sql`select ${claim.transcriptId}, ${installId}, ${recording.meetingId},
          ${Date.now()}, null where ${held}`,
      )
      .onConflictDoNothing(),
    db
      .update(t)
      .set({
        status: 'done',
        language: boundD1(result.language, 'language'),
        model: boundD1(result.model, 'model'),
        rawJson: {},
        rawPath: boundD1(path, 'raw_path'),
        pollDeadlineAt: null,
        ...(stored ? {} : { chunksTotal: null, chunksDone: null }),
        ...unclaim,
      })
      .where(and(eq(t.installId, installId), holds(claim.transcriptId, claim.token)))
      .returning({ id: t.id }),
    markTranscribedStatement(db, installId, recording.id, claim.transcriptId),
  ]);
  const written = (results.at(-2) as unknown[]).length > 0;
  if (!written) {
    // Another delivery won: its raw result stays, this one goes (pieces stay with their row).
    if (!stored) await storage.delete(path).catch(() => {});
    return { written };
  }
  await indexSegments(db, installId, recording.meetingId);
  return { written };
}

/**
 * The search index (packet 6) gets the meeting's segments again: every
 * recording's, never a comparison transcript's. A replace, so a later
 * delivery that runs it again changes nothing. A failure throws, and the
 * job's retry (the `finish` step) runs it once more.
 */
export async function indexSegments(db: Db, installId: string, meetingId: string) {
  await syncSearch(db, installId, {
    meetingId,
    segments: await meetingSegments(db, installId, meetingId),
  });
}

/** The recording `transcribed`, once its transcript row is done. */
function markTranscribedStatement(
  db: Db,
  installId: string,
  recordingId: string,
  transcriptId: string,
) {
  return db
    .update(r)
    .set({ status: 'transcribed', failure: null, failureReason: null })
    .where(
      and(
        eq(r.id, recordingId),
        eq(r.installId, installId),
        inArray(r.status, ['confirmed', 'transcribing']),
        sql`exists (select 1 from transcripts x where x.id = ${transcriptId}
          and x.install_id = ${installId} and x.status = 'done')`,
      ),
    );
}

/** For a done row a delivery found later: the recording status and the search index, if left behind. */
export async function finishDone(
  db: Db,
  installId: string,
  recordingId: string,
  transcriptId: string,
  meetingId?: string,
) {
  await markTranscribedStatement(db, installId, recordingId, transcriptId);
  if (meetingId) await indexSegments(db, installId, meetingId);
}

/**
 * Sends the recap jobs the outbox still owes: for one transcript at once
 * (right after its completion), or install-wide for rows left unsent past a
 * minute (any later delivery, the poll included). `sent_at` is set only
 * after the queue took the message; the consumer dedupes by transcript.
 */
export async function sendOutbox(
  db: Db,
  installId: string,
  queue: { send(job: Job): Promise<void> },
  only?: { transcriptId: string },
  now = Date.now(),
): Promise<number> {
  const o = schema.recapOutbox;
  const due = await db
    .select({ transcriptId: o.transcriptId, meetingId: o.meetingId })
    .from(o)
    .where(
      and(
        eq(o.installId, installId),
        isNull(o.sentAt),
        only
          ? eq(o.transcriptId, only.transcriptId)
          : lt(o.createdAt, new Date(now - OUTBOX_RESEND_MS)),
      ),
    )
    .limit(20);
  for (const row of due) {
    await queue.send({
      type: 'recap',
      meeting_id: row.meetingId,
      transcript_id: row.transcriptId,
      install_id: installId,
    });
    await db
      .update(o)
      .set({ sentAt: new Date() })
      .where(
        and(eq(o.transcriptId, row.transcriptId), eq(o.installId, installId), isNull(o.sentAt)),
      );
  }
  return due.length;
}

/**
 * The owner's Try again: the recording back to transcribing and its failed
 * transcript row to a fresh pending attempt (no job id, claim, deadline or
 * pieces), in one batch. The failed attempt's pieces go to storage cleanup
 * in the same batch; the next attempt plans under a prefix of its own.
 * False when the recording was not failed.
 */
export async function resetForRetry(
  db: Db,
  installId: string,
  meetingId: string,
  recordingId: string,
) {
  const [recordings] = await db.batch([
    db
      .update(r)
      .set({ status: 'transcribing', failure: null, failureReason: null })
      .where(
        and(
          eq(r.id, recordingId),
          eq(r.installId, installId),
          eq(r.meetingId, meetingId),
          eq(r.status, 'failed'),
          isNotNull(r.confirmedAt),
        ),
      )
      .returning({ id: r.id }),
    // The failed attempt's pieces, a prefix in raw_path, are deleted later (storage_cleanup).
    db.insert(schema.storageCleanup).select(
      sql`select lower(hex(randomblob(16))), ${installId}, x.raw_path, ${Date.now()}, 0
      from transcripts x where x.recording_id = ${recordingId} and x.install_id = ${installId}
        and x.is_comparison = 0 and x.status in ('failed', 'pending') and x.raw_path like '%/'
        and exists (select 1 from recordings y where y.id = ${recordingId}
          and y.install_id = ${installId} and y.status = 'transcribing')`,
    ),
    db
      .update(t)
      .set({
        status: 'pending',
        providerJobId: null,
        pollDeadlineAt: null,
        chunksTotal: null,
        chunksDone: null,
        rawPath: sql`case when ${t.rawPath} like '%/' then null else ${t.rawPath} end`,
        ...unclaim,
      })
      .where(
        and(
          eq(t.recordingId, recordingId),
          eq(t.installId, installId),
          eq(t.isComparison, false),
          inArray(t.status, ['failed', 'pending']),
          // Only the recording reset above makes this row a fresh attempt.
          sql`exists (select 1 from recordings x where x.id = ${recordingId}
            and x.install_id = ${installId} and x.status = 'transcribing')`,
        ),
      ),
  ]);
  return recordings.length > 0;
}

/** The recap consumer's guard: true the first time a transcript's recap job is taken. */
export async function takeRecapJob(db: Db, installId: string, transcriptId: string) {
  const taken = await db
    .insert(schema.recapJobsSeen)
    .values({ installId, transcriptId })
    .onConflictDoNothing()
    .returning({ id: schema.recapJobsSeen.transcriptId });
  return taken.length > 0;
}

/**
 * Recordings that need a transcribe job: confirmed or transcribing, with no
 * transcript row or a pending one that was never submitted and is not held.
 * 100 per call, by id after `after`, for the drain job.
 */
export async function waitingRecordings(db: Db, installId: string, after: string | undefined) {
  const now = Date.now();
  return db
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(r.installId, installId),
        inArray(r.status, ['confirmed', 'transcribing']),
        ...(after ? [gt(r.id, after)] : []),
        sql`not exists (select 1 from transcripts x where x.install_id = ${installId}
          and x.recording_id = ${r.id} and x.is_comparison = 0
          and not (x.status = 'pending' and x.provider_job_id is null
            and (x.claim_expires_at is null or x.claim_expires_at < ${now})))`,
      ),
    )
    .orderBy(r.id)
    .limit(100);
}

/** One step of the drain: queue up to 100 waiting recordings, then the next step if there may be more. */
export async function drainStep(
  db: Db,
  installId: string,
  queue: { sendBatch(jobs: { body: Job }[]): Promise<void>; send(job: Job): Promise<void> },
  after: string | undefined,
): Promise<number> {
  const waiting = await waitingRecordings(db, installId, after);
  if (waiting.length) {
    await queue.sendBatch(
      waiting.map((w) => ({
        body: { type: 'transcribe', recording_id: w.id, install_id: installId } as Job,
      })),
    );
  }
  if (waiting.length === 100) {
    await queue.send({
      type: 'drain_transcriptions',
      install_id: installId,
      after: waiting.at(-1)!.id,
    });
  }
  return waiting.length;
}
