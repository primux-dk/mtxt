/**
 * What a transcribe job does next, from the recording's status and its
 * transcript row (docs/decisions.md, packet 4). Pure, so the state machine
 * is tested on its own.
 *
 *   confirmed / transcribing, no row      -> submit
 *   confirmed / transcribing, pending row -> fetch when it has a job id, else submit again
 *   confirmed / transcribing, done row    -> finish (a run that stopped after writing)
 *   confirmed / transcribing, failed row  -> submit again (Try again re-queued it)
 *   transcribed, failed, uploading        -> nothing: finished, failed or not ready
 */
import type { RecordingStatus, TranscriptStatus } from '@mtxt/adapters';

export type Step = 'skip' | 'submit' | 'fetch' | 'finish';

export function nextStep(
  recording: RecordingStatus,
  transcript: { status: TranscriptStatus; providerJobId: string | null } | null,
): Step {
  if (recording !== 'confirmed' && recording !== 'transcribing') return 'skip';
  if (!transcript || transcript.status === 'failed') return 'submit';
  if (transcript.status === 'done') return 'finish';
  return transcript.providerJobId ? 'fetch' : 'submit';
}

/** Whether a webhook for this transcript should wake the job: only a pending, real one. */
export const webhookWakes = (
  transcript: { status: TranscriptStatus; isComparison: boolean } | null | undefined,
) => Boolean(transcript && transcript.status === 'pending' && !transcript.isComparison);
