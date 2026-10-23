/**
 * What a transcribe job does next, from the recording's status and its
 * transcript row (docs/decisions.md, packet 4). Pure, so the state machine
 * is tested on its own. The job never resets a terminal row: only the
 * owner's Try again turns a failed row back to pending.
 *
 *   confirmed / transcribing, no row           -> submit
 *   confirmed / transcribing, pending, no job  -> submit (claims first)
 *   confirmed / transcribing, pending, job id  -> fetch (claims first)
 *   confirmed / transcribing, done             -> finish (status and recap)
 *   transcribed, done, recap not yet queued    -> finish (the recap)
 *   anything else                              -> nothing
 */
import type { RecordingStatus, TranscriptStatus } from '@mtxt/adapters';

export type Step = 'skip' | 'submit' | 'fetch' | 'finish';

export function nextStep(
  recording: RecordingStatus,
  transcript: {
    status: TranscriptStatus;
    providerJobId: string | null;
    recapEnqueuedAt?: Date | null;
  } | null,
): Step {
  if (recording === 'transcribed') {
    return transcript?.status === 'done' && !transcript.recapEnqueuedAt ? 'finish' : 'skip';
  }
  if (recording !== 'confirmed' && recording !== 'transcribing') return 'skip';
  if (!transcript) return 'submit';
  if (transcript.status === 'done') return 'finish';
  if (transcript.status === 'failed') return 'skip';
  return transcript.providerJobId ? 'fetch' : 'submit';
}

/** Whether a webhook for this transcript should wake the job: only a pending, real one. */
export const webhookWakes = (
  transcript: { status: TranscriptStatus; isComparison: boolean } | null | undefined,
) => Boolean(transcript && transcript.status === 'pending' && !transcript.isComparison);
