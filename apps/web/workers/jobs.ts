import {
  cloudflareAdapters,
  pruneOAuthGrants,
  pruneRecorderRows,
  readSettings,
  retentionBatch,
  retryStorageCleanup,
  routeJobs,
  type RetentionJob,
} from '@mtxt/adapters';
import { runTranscribe } from '../lib/transcription/job';
import { transcriptionDeps } from '../lib/transcription/deps';
import { drainStep } from '../lib/transcription/store';
import { recapDeps } from '../lib/recap/deps';
import { runRecap } from '../lib/recap/job';
import { runWebhook } from '../lib/webhooks/deliver';
import { webhookDeps } from '../lib/webhooks/deps';
import { sweepDeliveries } from '../lib/webhooks/store';

/**
 * The queue consumer, routed by job type. A transcribe job runs the
 * install's speech-to-text provider (lib/transcription/job.ts); a throw
 * puts the message back on the queue. A drain job queues the recordings
 * that waited for a provider, 100 at a time. A recap job drafts the recap
 * with the install's recap model (lib/recap/job.ts). A webhook job makes
 * one attempt of one delivery (lib/webhooks/deliver.ts).
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
    // A retryable failure throws, and the router puts the message back.
    await runRecap(await recapDeps(env), job, message.attempts);
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
  async webhook(job, message, env) {
    if (job.install_id !== env.INSTALL_ID) {
      console.error('Dropping a webhook job for another install', job.install_id);
      message.ack();
      return;
    }
    // An unexpected error throws and the router puts the message back; the claim stops a double send.
    await runWebhook(webhookDeps(env), job);
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
  const batch = job.batch ?? 0;
  if (batch === 0) {
    // Objects whose rows are gone but that storage refused before: one more try each.
    const cleanup = await retryStorageCleanup(db, storage, installId);
    console.log(
      `Storage cleanup: ${cleanup.deleted} deleted, ${cleanup.failed} still failing, ${cleanup.givenUp} given up`,
    );
    // Recorder grants that expired over a day ago, tokens revoked or expired over 90 days ago.
    const pruned = await pruneRecorderRows(db, installId, new Date(job.now));
    console.log(`Recorder rows: ${pruned.grants} grants, ${pruned.tokens} tokens deleted`);
    // MCP authorization codes that expired over a day ago.
    const codes = await pruneOAuthGrants(db, installId, new Date(job.now));
    console.log(`OAuth codes: ${codes} deleted`);
    // Webhook deliveries finished over 30 days ago go; one whose message was lost is sent again.
    const swept = await sweepDeliveries({ db, installId, queue }, new Date(job.now));
    console.log(`Webhook deliveries: ${swept.pruned} pruned, ${swept.requeued} queued again`);
  }
  // The night's first batch lists what is past a deadline and left alone; later ones add what changed meanwhile.
  const result = await retentionBatch(
    { db, storage, installId },
    settings,
    new Date(job.now),
    undefined,
    {
      reportSkips: batch === 0,
    },
  );
  for (const skip of result.skipped) console.info(`Retention skipped ${skip.id}: ${skip.reason}`);
  const skips = Object.entries(
    result.skipped.reduce<Record<string, number>>(
      (n, s) => ({ ...n, [s.reason]: (n[s.reason] ?? 0) + 1 }),
      {},
    ),
  )
    .map(([reason, n]) => `${n} ${reason}`)
    .join(', ');
  console.log(
    `Retention as of ${new Date(job.now).toISOString()}, batch ${batch}: ${result.meetings} meetings, ` +
      `${result.audioDeleted} audio, ${result.textDeleted} transcripts, ${result.markedDeleted} marked deleted, ` +
      `skipped ${skips || 'none'}` +
      (result.more ? '; queueing the next batch' : ''),
  );
  if (result.more) {
    await queue.send({ type: 'retention', install_id: installId, now: job.now, batch: batch + 1 });
  }
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
