/*
  The transcribe job (docs/decisions.md, packet 4 and its review). Loads the
  recording and the settings, claims the transcript row, submits the audio
  to the install's provider, and stores the result: at once for a
  synchronous provider, after the webhook (or the delayed poll) wakes the
  job again for an async one. A provider error that is worth another try
  goes back to the queue, up to MAX_ATTEMPTS deliveries; anything else fails
  the recording with a fixed reason, and the audio stays. Nothing a provider
  says in its own words is logged or stored.
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
  markFailed,
  markTranscribing,
  primaryTranscript,
  release,
  storeJobId,
  unmarkRecap,
} from './store';

export const MAX_ATTEMPTS = 3;
/** The delayed check on an async job, in case its webhook never comes. */
export const POLL_DELAY_S = 300;
/** Past this, a job the provider still has is given up as a timeout. */
export const POLL_GIVE_UP_MS = 6 * 3600_000;

export interface TranscribeDeps {
  db: Db;
  installId: string;
  storage: StorageAdapter;
  queue: QueueAdapter;
  /** The provider for these settings (lib/stt providerFor, bound to the Worker's env). */
  provider: (settings: Settings) => Promise<SttProvider>;
  log?: Pick<Console, 'log' | 'error'>;
}

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
): Promise<void> {
  const { db, installId } = deps;
  const log = deps.log ?? console;
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

  /** The recap job, once per transcript; a failed send takes the mark off for the next delivery. */
  const sendRecap = async (transcriptId: string) => {
    try {
      await deps.queue.send({
        type: 'recap',
        meeting_id: rec.meetingId,
        transcript_id: transcriptId,
        install_id: installId,
      });
    } catch (error) {
      await unmarkRecap(db, installId, transcriptId);
      throw error;
    }
    // TODO(packet 6): syncSearch(db, installId, rec.meetingId) once the adapters export it.
  };
  let claim: { transcriptId: string; token: string; provider: string } | null = null;
  const complete = async (result: SttResult) => {
    const done = await completeTranscript(db, deps.storage, installId, rec, claim!, result);
    if (!done.written) log.log('Another delivery finished the transcript first', recordingId);
    if (done.recapDue) await sendRecap(claim!.transcriptId);
  };

  try {
    if (step === 'finish') {
      const { recapDue } = await finishDone(db, installId, recordingId, transcript!.id);
      if (recapDue) await sendRecap(transcript!.id);
      return;
    }

    const settings = await readSettings(db, installId);
    if (step === 'fetch') {
      const held = await claimTranscript(db, installId, recordingId, 'fetch');
      if (!held) return log.log('The transcript is held by another delivery', recordingId);
      claim = { transcriptId: held.id, token: held.claimToken, provider: held.provider };
      // The job a webhook or the poll woke: ask the provider that holds it.
      const provider = await deps.provider({
        ...settings,
        sttProvider: held.provider as Settings['sttProvider'],
      });
      if (!provider.fetch) throw new SttError('stt_failed', 'internal');
      const fetched = await provider.fetch(held.providerJobId!);
      if (fetched.kind === 'done') return await complete(fetched.result);
      if (fetched.kind === 'failed') {
        await markFailed(db, installId, recordingId, claim, 'stt_failed', fetched.reason);
        return;
      }
      await release(db, installId, held.id, held.claimToken);
      if (options.poll) {
        if (Date.now() - held.createdAt.getTime() > POLL_GIVE_UP_MS) {
          await markFailed(db, installId, recordingId, null, 'stt_failed', 'timeout');
          return;
        }
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
    const held = await claimTranscript(db, installId, recordingId, 'submit', {
      provider: id,
      model,
    });
    if (!held) return log.log('The transcript is held by another delivery', recordingId);
    claim = { transcriptId: held.id, token: held.claimToken, provider: id };
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
      await storeJobId(db, installId, held.id, held.claimToken, submitted.handle);
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
