import { routeJobs } from '@mtxt/adapters';

/**
 * The queue consumer, routed by job type. Transcription arrives in packet 4:
 * until then a transcribe job is logged and acked, and the recording stays
 * `transcribing`. Recap jobs have no handler yet (packet 5).
 */
export const handleJobs = routeJobs<CloudflareEnv>({
  async transcribe(job, message) {
    console.log('Transcription is not implemented yet; acking', job.recording_id);
    message.ack();
  },
});
