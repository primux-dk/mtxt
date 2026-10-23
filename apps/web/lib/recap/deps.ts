/**
 * The recap job's dependencies for one Worker env: the adapters and the
 * install's recap model with its key opened at call time. Used by the queue
 * consumer, which wrangler bundles (not Next.js).
 *
 * The e2e run's fake model (lib/recap/test-hooks.ts) loads only when the
 * bundle is built with `--define MTXT_E2E_BUILD:"1"`; a deployed Worker
 * defines it as "" and esbuild drops the import (`pnpm check:no-fakes`).
 */
import { cloudflareAdapters } from '@mtxt/adapters';
import { takeRecapJob } from '../transcription/store';
import type { RecapDeps } from './job';
import { recapLlm, type RecapLlm } from './llm';

export async function recapDeps(env: CloudflareEnv): Promise<RecapDeps> {
  const adapters = cloudflareAdapters(env);
  const { db, installId } = adapters;
  // Written inline, not through a constant: esbuild drops the import only when the
  // condition itself folds to false.
  const fake: RecapLlm | undefined =
    typeof MTXT_E2E_BUILD !== 'undefined' && MTXT_E2E_BUILD === '1'
      ? (await import('./test-hooks')).e2eRecapOverride(env)
      : undefined;
  return {
    db,
    installId,
    takeOnce: (transcriptId) => takeRecapJob(db, installId, transcriptId).catch(() => false),
    llm: async (settings) =>
      fake ?? recapLlm(settings, { language: adapters.language, settingsKey: env.SETTINGS_KEY }),
  };
}
