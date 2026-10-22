/*
  The transcribe job (docs/decisions.md, packet 4). Loads the recording and
  the settings, submits the audio to the install's provider, and stores the
  transcript: at once for a synchronous provider, after the webhook wakes
  the job again for an async one. A provider error that is worth another
  try goes back to the queue, up to MAX_ATTEMPTS deliveries; anything else
  fails the recording with the reason, and the audio stays.
*/
import { and, desc, eq } from 'drizzle-orm';
import {
  listKeyterms,
  readSettings,
  schema,
  type Db,
  type QueueAdapter,
  type Settings,
  type StorageAdapter,
} from '@mtxt/adapters';
import { SttError, type SttProvider, type SttResult } from '../stt/types';
import { nextStep } from './state';
import {
  claimTranscript,
  markFailed,
  markTranscribed,
  markTranscribing,
  primaryTranscript,
  setJobId,
  writeResult,
} from './store';

export const MAX_ATTEMPTS = 3;

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
  let transcript = await primaryTranscript(db, installId, recordingId);
  const step = nextStep(rec.status, transcript);

  const finish = async (transcriptId: string, result: SttResult) => {
    await writeResult(db, installId, rec.meetingId, transcriptId, result);
    await done();
  };
  // The recap job goes out before the status flips, so a crash between the
  // two heals on the next delivery (the row is done, the status is not).
  const done = async () => {
    await deps.queue.send({ type: 'recap', meeting_id: rec.meetingId, install_id: installId });
    await markTranscribed(db, installId, recordingId);
    // TODO(packet 6): syncSearch(db, installId, rec.meetingId) once the adapters export it.
  };

  if (step === 'skip') return;

  const settings = await readSettings(db, installId);
  if (!settings.sttProvider && step === 'submit') {
    // The data-flow panel's promise: audio is stored and transcription waits for a
    // provider. Saving one in Settings queues every waiting recording (queueWaiting).
    log.log('No speech-to-text provider yet; the recording waits', recordingId);
    await markTranscribing(db, installId, recordingId);
    return;
  }
  try {
    if (step === 'finish') return await done();
    if (step === 'fetch' && transcript) {
      // The job a webhook woke: ask the provider that holds it.
      const provider = await deps.provider({
        ...settings,
        sttProvider: transcript.provider as Settings['sttProvider'],
      });
      if (!provider.fetch) throw new SttError('stt_failed', 'The provider has no async jobs.');
      const fetched = await provider.fetch(transcript.providerJobId!);
      if (fetched.kind === 'done') return await finish(transcript.id, fetched.result);
      if (fetched.kind === 'failed') {
        await markFailed(db, installId, recordingId, transcript.id, 'stt_failed', fetched.reason);
        return;
      }
      log.log('Transcript still processing; the webhook wakes it', recordingId);
      return;
    }

    const provider = await deps.provider(settings);
    const { id, model } = provider.describe();
    transcript = await claimTranscript(db, installId, recordingId, id, model);
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
        if (!object) throw new SttError('stt_failed', 'The audio file is missing from storage.');
        return object.body;
      },
    });
    if (submitted.kind === 'pending') {
      await setJobId(db, installId, transcript.id, submitted.handle);
      return;
    }
    return await finish(transcript.id, submitted.result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retry = !(error instanceof SttError) || error.retryable;
    if (retry && attempt < MAX_ATTEMPTS) {
      log.error(`Transcription attempt ${attempt} failed; retrying`, recordingId, message);
      throw error;
    }
    const code = error instanceof SttError ? error.code : 'stt_failed';
    log.error('Transcription failed', recordingId, code, message);
    await markFailed(db, installId, recordingId, transcript?.id ?? null, code, message);
  }
}

/** The provider named on a recording's latest transcript row, for the failed and transcribing states. */
export async function latestProvider(db: Db, installId: string, recordingId: string) {
  const row = await db
    .select({ provider: schema.transcripts.provider })
    .from(schema.transcripts)
    .where(
      and(
        eq(schema.transcripts.installId, installId),
        eq(schema.transcripts.recordingId, recordingId),
        eq(schema.transcripts.isComparison, false),
      ),
    )
    .orderBy(desc(schema.transcripts.createdAt))
    .get();
  return row?.provider ?? null;
}
