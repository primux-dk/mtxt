/**
 * The webhook job's dependencies for one Worker env. Used by the queue
 * consumer, which wrangler bundles (not Next.js). The e2e run's receiver on
 * http://localhost passes the address check only in a bundle built with
 * `--define MTXT_E2E_BUILD:"1"` and with AUTH_TEST_MODE=1; a deployed Worker
 * defines the flag as "" and esbuild folds the condition away.
 */
import { cloudflareAdapters } from '@mtxt/adapters';
import type { WebhookDeps } from './deliver';

export function webhookDeps(env: CloudflareEnv): WebhookDeps {
  const adapters = cloudflareAdapters(env);
  const allowLocal =
    typeof MTXT_E2E_BUILD !== 'undefined' && MTXT_E2E_BUILD === '1' && env.AUTH_TEST_MODE === '1';
  return {
    db: adapters.db,
    installId: adapters.installId,
    queue: adapters.queue,
    resolver: adapters.resolver,
    settingsKey: env.SETTINGS_KEY,
    publicUrl: env.PUBLIC_URL,
    allowLocal,
  };
}
