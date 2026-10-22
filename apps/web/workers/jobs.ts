import {
  cloudflareAdapters,
  readSettings,
  retentionBatch,
  routeJobs,
  type RetentionJob,
} from '@mtxt/adapters';
import { runTranscribe } from '../lib/transcription/job';
import { transcriptionDeps } from '../lib/transcription/deps';
import { drainStep, takeRecapJob } from '../lib/transcription/store';

/**
 * The queue consumer, routed by job type. A transcribe job runs the
 * install's speech-to-text provider (lib/transcription/job.ts); a throw
 * puts the message back on the queue. A drain job queues the recordings
 * that waited for a provider, 100 at a time. Recap jobs are taken once per
 * transcript and logged until packet 5 writes the recap.
 */
export const handleJobs = routeJobs<CloudflareEnv>({
  async transcribe(job, message, env) {
    // One install per Worker: a job for another install is not ours to run.
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a transcribe job for another install', job.install_id);
      message.ack();
      return;
    }
    const outcome = await runTranscribe(
      await transcriptionDeps(env),
      job.recording_id,
      message.attempts,
      { poll: job.poll === true },
    );
    // Held by a live claim: not acked, back when the claim lapses (never stranded).
    if (outcome) message.retry({ delaySeconds: outcome.retryAfterS });
    else message.ack();
  },
  async recap(job, message, env) {
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a recap job for another install', job.install_id);
      message.ack();
      return;
    }
    const { db } = cloudflareAdapters(env);
    // One recap job per transcript, whatever the queue delivers twice.
    const first = await takeRecapJob(db, env.INSTALL_ID, job.transcript_id).catch(() => false);
    if (!first) {
      console.log(
        'Recap job already taken, or its transcript is gone; skipping',
        job.transcript_id,
      );
    } else {
      console.log('Recaps arrive in packet 5; acking the recap job for', job.meeting_id);
    }
    message.ack();
  },
  async drain_transcriptions(job, message, env) {
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a drain job for another install', job.install_id);
      message.ack();
      return;
    }
    const { db, queue } = cloudflareAdapters(env);
    const queued = await drainStep(db, env.INSTALL_ID, queue, job.after);
    console.log(`Queued ${queued} waiting recordings for transcription`);
    message.ack();
  },
  async retention(job, message, env) {
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a retention job for another install', job.install_id);
      message.ack();
      return;
    }
    await runRetention(job, env);
    message.ack();
  },
});

/**
 * One batch of retention (packages/adapters, src/db/retention.ts). A full
 * batch queues the next with the same `now`, so one night's batches apply
 * one set of deadlines. A throw retries the job; a batch that ran halfway
 * finds what is left on the retry.
 */
export async function runRetention(job: RetentionJob, env: CloudflareEnv) {
  const { db, storage, queue, installId } = cloudflareAdapters(env);
  const settings = await readSettings(db, installId);
  const result = await retentionBatch({ db, storage, installId }, settings, new Date(job.now));
  console.log(
    `Retention as of ${new Date(job.now).toISOString()}: ${result.meetings} meetings, ` +
      `${result.audioDeleted} audio, ${result.textDeleted} transcripts, ${result.markedDeleted} marked deleted` +
      (result.more ? '; queueing the next batch' : ''),
  );
  if (result.more) await queue.send({ type: 'retention', install_id: installId, now: job.now });
}

/**
 * The Cron Trigger (wrangler.jsonc, daily at 03:00 UTC). It only queues the
 * first retention batch through the queue adapter; the consumer does the work.
 */
export async function scheduleRetention(scheduledTime: number, env: CloudflareEnv) {
  const { queue, installId } = cloudflareAdapters(env);
  await queue.send({ type: 'retention', install_id: installId, now: scheduledTime });
  console.log(`Queued retention for ${new Date(scheduledTime).toISOString()}`);
}
