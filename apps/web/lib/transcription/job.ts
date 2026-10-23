/*
  The transcribe job (docs/decisions.md, packet 4 and its reviews). Loads
  the recording and the settings, claims the transcript row, submits the
  audio to the install's provider, and stores the result: at once for a
  synchronous provider, after the webhook (or the delayed poll) wakes the
  job again for an async one. A delivery that finds the row held by a live
  claim is not acked: it asks the queue to bring it back when the claim
  lapses, so a crashed claimant never strands the recording. A provider
  error worth another try goes back to the queue, up to MAX_ATTEMPTS
  deliveries; anything else fails the attempt with a fixed reason, and the
  audio stays. Nothing a provider says in its own words is logged or stored.
*/
import { and, eq } from 'drizzle-orm';
import {
  listKeyterms,
  readSettings,
  schema,
  type Db,
  type QueueAdapter,
  type Settings,
  type StorageAdapter,
} from '@mtxt/adapters';
import { describeError } from '../stt/redact';
import { SttError, type SttProvider, type SttResult } from '../stt/types';
import { nextStep } from './state';
import {
  claimTranscript,
  completeTranscript,
  ensureTranscript,
  finishDone,
  heldUntil,
  markFailed,
  markTranscribing,
  primaryTranscript,
  release,
  sendOutbox,
  storeJobId,
} from './store';

export const MAX_ATTEMPTS = 3;
/** The delayed check on an async job, in case its webhook never comes. */
export const POLL_DELAY_S = 300;
/** A held delivery comes back no sooner than this, and when the claim lapses. */
export const HELD_RETRY_MIN_S = 60;

export interface TranscribeDeps {
  db: Db;
  installId: string;
  storage: StorageAdapter;
  queue: QueueAdapter;
  /** The provider for these settings (lib/stt providerFor, bound to the Worker's env). */
  provider: (settings: Settings) => Promise<SttProvider>;
  log?: Pick<Console, 'log' | 'error'>;
}

/** What the consumer does with the message: ack, or bring it back after a delay. */
export type Outcome = { retryAfterS: number } | void;

/** The install's keyterms for a provider: highest weight first, then the saved order. */
export async function keytermList(db: Db, installId: string): Promise<string[]> {
  const terms = await listKeyterms(db, installId);
  return terms
    .map((term, i) => ({ ...term, i }))
    .sort((a, b) => (b.boost ?? 1) - (a.boost ?? 1) || a.i - b.i)
    .map((term) => term.term);
}

export async function runTranscribe(
  deps: TranscribeDeps,
  recordingId: string,
  attempt: number,
  options: { poll?: boolean } = {},
): Promise<Outcome> {
  const { db, installId } = deps;
  const log = deps.log ?? console;

  // Any recap a crashed delivery left in the outbox goes out now.
  await sendOutbox(db, installId, deps.queue).catch((error) =>
    log.error('Could not send the recap outbox yet', describeError(error)),
  );

  const row = await db
    .select({ recording: schema.recordings, meeting: schema.meetings })
    .from(schema.recordings)
    .innerJoin(
      schema.meetings,
      and(
        eq(schema.meetings.id, schema.recordings.meetingId),
        eq(schema.meetings.installId, installId),
      ),
    )
    .where(and(eq(schema.recordings.id, recordingId), eq(schema.recordings.installId, installId)))
    .get();
  if (!row || row.meeting.deletedAt) {
    log.log('No such recording to transcribe; acking', recordingId);
    return;
  }
  const rec = row.recording;
  const transcript = await primaryTranscript(db, installId, recordingId);
  const step = nextStep(rec.status, transcript);
  if (step === 'skip') return;

  /** Not acked: the queue brings the message back when the other delivery's claim lapses. */
  const held = async (): Promise<Outcome> => {
    const until = await heldUntil(db, installId, recordingId);
    if (!until) return; // The row moved on (done or failed): nothing left to do.
    const wait = Math.ceil((until.getTime() - Date.now()) / 1000) + 1;
    log.log('The transcript is held by another delivery; back when its claim lapses', recordingId);
    return { retryAfterS: Math.max(HELD_RETRY_MIN_S, wait) };
  };

  let claim: { transcriptId: string; token: string; provider: string } | null = null;
  const complete = async (result: SttResult) => {
    const done = await completeTranscript(db, deps.storage, installId, rec, claim!, result);
    if (!done.written) log.log('Another delivery finished the transcript first', recordingId);
    // The outbox row is in D1 already; this sends it, and any later delivery would too.
    await sendOutbox(db, installId, deps.queue, { transcriptId: claim!.transcriptId });
    // The search index got the segments in completeTranscript (indexSegments).
  };

  try {
    if (step === 'finish') {
      await finishDone(db, installId, recordingId, transcript!.id, rec.meetingId);
      await sendOutbox(db, installId, deps.queue, { transcriptId: transcript!.id });
      return;
    }

    const settings = await readSettings(db, installId);
    if (step === 'fetch') {
      const taken = await claimTranscript(db, installId, recordingId, 'fetch');
      if (!taken) return await held();
      claim = { transcriptId: taken.id, token: taken.claimToken, provider: taken.provider };
      // The job a webhook or the poll woke: ask the provider that holds it.
      const provider = await deps.provider({
        ...settings,
        sttProvider: taken.provider as Settings['sttProvider'],
      });
      if (!provider.fetch) throw new SttError('stt_failed', 'internal');
      const fetched = await provider.fetch(taken.providerJobId!);
      if (fetched.kind === 'done') return await complete(fetched.result);
      if (fetched.kind === 'failed') {
        await markFailed(db, installId, recordingId, claim, 'stt_failed', fetched.reason);
        return;
      }
      if (options.poll && taken.pollDeadlineAt && taken.pollDeadlineAt.getTime() < Date.now()) {
        // The attempt is over: transcript and recording fail together, under the claim.
        await markFailed(db, installId, recordingId, claim, 'stt_failed', 'timeout');
        return;
      }
      await release(db, installId, taken.id, taken.claimToken);
      if (options.poll) {
        await deps.queue.send(
          { type: 'transcribe', recording_id: recordingId, install_id: installId, poll: true },
          { delaySeconds: POLL_DELAY_S },
        );
      }
      return;
    }

    // submit
    if (!settings.sttProvider) {
      // The data-flow panel's promise: audio is stored and transcription waits for a
      // provider. Saving one in Settings starts the drain job.
      log.log('No speech-to-text provider yet; the recording waits', recordingId);
      await markTranscribing(db, installId, recordingId);
      return;
    }
    const provider = await deps.provider(settings);
    const { id, model } = provider.describe();
    await ensureTranscript(db, installId, recordingId, id, model);
    const taken = await claimTranscript(db, installId, recordingId, 'submit', {
      provider: id,
      model,
    });
    if (!taken) return await held();
    claim = { transcriptId: taken.id, token: taken.claimToken, provider: id };
    await markTranscribing(db, installId, recordingId);
    const submitted = await provider.submit({
      recordingId,
      contentType: rec.contentType,
      sizeBytes: rec.sizeBytes,
      durationS: rec.durationS,
      language: settings.language,
      keyterms: await keytermList(db, installId),
      audio: async () => {
        const object = await deps.storage.get(rec.storagePath);
        if (!object) throw new SttError('stt_failed', 'missing_audio');
        return object.body;
      },
    });
    if (submitted.kind === 'pending') {
      await storeJobId(db, installId, taken.id, taken.claimToken, submitted.handle);
      // The webhook wakes it; this delayed check covers a webhook that never comes.
      await deps.queue.send(
        { type: 'transcribe', recording_id: recordingId, install_id: installId, poll: true },
        { delaySeconds: POLL_DELAY_S },
      );
      return;
    }
    return await complete(submitted.result);
  } catch (error) {
    const known = error instanceof SttError ? error : null;
    const retry = !known || known.retryable;
    if (retry && attempt < MAX_ATTEMPTS) {
      log.error(
        `Transcription attempt ${attempt} failed; retrying`,
        recordingId,
        describeError(error),
      );
      // The claim goes, so the next delivery can take the row at once.
      if (claim) await release(db, installId, claim.transcriptId, claim.token).catch(() => {});
      throw error;
    }
    const code = known?.code ?? 'stt_failed';
    const reason = known?.stored ?? 'internal';
    log.error('Transcription failed', recordingId, code, reason, describeError(error));
    await markFailed(db, installId, recordingId, claim, code, reason);
  }
}
