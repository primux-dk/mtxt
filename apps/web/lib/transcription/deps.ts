/**
 * The transcription dependencies for one Worker env: the adapters, the
 * install's provider with its key opened at call time, and, in a test run
 * only, the fake providers (lib/stt/test-hooks.ts). Used by the queue
 * consumer and the webhook route alike.
 */
import { cloudflareAdapters, ensureWebhookSecret, seal } from '@mtxt/adapters';
import { providerFor } from '../stt';
import { fakeAssemblyAiUrl, fakeSpeech } from '../stt/test-hooks';
import type { TranscribeDeps } from './job';

export function transcriptionDeps(env: CloudflareEnv): TranscribeDeps {
  const adapters = cloudflareAdapters(env);
  const { db, installId } = adapters;
  const speech = fakeSpeech(env) ?? adapters.speech;
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
        webhookSecret: () =>
          ensureWebhookSecret(db, installId, (plain) => {
            if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set.');
            return seal(plain, 'settings.webhook_secret', env.SETTINGS_KEY);
          }),
        assemblyAiBaseUrl: fakeAssemblyAiUrl(env),
      }),
  };
}
