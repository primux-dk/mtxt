import { routeJobs } from '@mtxt/adapters';

/**
 * The queue consumer, routed by job type. Transcription arrives in packet 4:
 * until then a transcribe job is logged and acked, and the recording stays
 * `transcribing`. Recap jobs have no handler yet (packet 5).
 */
export const handleJobs = routeJobs<CloudflareEnv>({
  async transcribe(job, message, env) {
    // One install per Worker: a job for another install is not ours to run.
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a transcribe job for another install', job.install_id);
      message.ack();
      return;
    }
    console.log('Transcription is not implemented yet; acking', job.recording_id);
    message.ack();
  },
});
