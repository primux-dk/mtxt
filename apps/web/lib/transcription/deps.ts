/**
 * The transcription dependencies for one Worker env: the adapters and the
 * install's provider with its key opened at call time. Used by the queue
 * consumer, which wrangler bundles (not Next.js).
 *
 * The e2e run's fake providers (lib/stt/test-hooks.ts) load only when the
 * bundle is built with `--define MTXT_E2E_BUILD:"1"` (playwright.config.ts).
 * wrangler.jsonc defines it as "", so esbuild drops the import from a
 * deployed Worker; `pnpm check:no-fakes` greps the production bundle.
 */
import { cloudflareAdapters, ensureWebhookSecret, seal, type SpeechModels } from '@mtxt/adapters';
import { providerFor } from '../stt';
import type { TranscribeDeps } from './job';

export async function transcriptionDeps(env: CloudflareEnv): Promise<TranscribeDeps> {
  const adapters = cloudflareAdapters(env);
  const { db, installId } = adapters;
  // Written inline, not through a constant: esbuild drops the import only when the
  // condition itself folds to false.
  const e2e = typeof MTXT_E2E_BUILD !== 'undefined' && MTXT_E2E_BUILD === '1';
  const test: { speech?: SpeechModels; assemblyAiBaseUrl?: string } =
    typeof MTXT_E2E_BUILD !== 'undefined' && MTXT_E2E_BUILD === '1'
      ? (await import('../stt/test-hooks')).e2eOverrides(env)
      : {};
  const speech = test.speech ?? adapters.speech;
  return {
    db,
    installId,
    storage: adapters.storage,
    queue: adapters.queue,
    provider: (settings) =>
      providerFor(settings, {
        settingsKey: env.SETTINGS_KEY,
        speech,
        publicUrl: env.PUBLIC_URL,
        // http://localhost is a webhook address only in the e2e build or local wrangler.
        allowLocalPublicUrl: e2e || env.MTXT_LOCAL_DEV === '1',
        webhookSecret: () =>
          ensureWebhookSecret(db, installId, (plain) => {
            if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set.');
            return seal(plain, 'settings.webhook_secret', env.SETTINGS_KEY);
          }),
        assemblyAiBaseUrl: test.assemblyAiBaseUrl,
      }),
  };
}
