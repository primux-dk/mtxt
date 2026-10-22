import { routeJobs } from '@mtxt/adapters';
import { runTranscribe } from '../lib/transcription/job';
import { transcriptionDeps } from '../lib/transcription/deps';

/**
 * The queue consumer, routed by job type. A transcribe job runs the
 * install's speech-to-text provider (lib/transcription/job.ts); a throw
 * puts the message back on the queue. Recap jobs are acked and logged until
 * packet 5 writes the recap.
 */
export const handleJobs = routeJobs<CloudflareEnv>({
  async transcribe(job, message, env) {
    // One install per Worker: a job for another install is not ours to run.
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a transcribe job for another install', job.install_id);
      message.ack();
      return;
    }
    await runTranscribe(transcriptionDeps(env), job.recording_id, message.attempts);
    message.ack();
  },
  async recap(job, message, env) {
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a recap job for another install', job.install_id);
      message.ack();
      return;
    }
    console.log('Recaps arrive in packet 5; acking the recap job for', job.meeting_id);
    message.ack();
  },
});
