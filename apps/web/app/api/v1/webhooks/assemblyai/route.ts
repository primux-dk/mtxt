import { readSettings } from '@mtxt/adapters';
import { getAdapters, getEnv } from '@/lib/install';
import { assemblyAiWebhook } from '@/lib/transcription/webhook';

/*
  AssemblyAI calls this when a transcript is done (lib/transcription/webhook.ts).
  No session: the install's webhook secret in a custom header authenticates it,
  so the middleware lets the path through (lib/auth/session-config.ts).
*/
export async function POST(request: Request) {
  const [{ db, installId, queue }, env] = await Promise.all([getAdapters(), getEnv()]);
  const settings = await readSettings(db, installId);
  return assemblyAiWebhook(request, {
    db,
    installId,
    queue,
    settingsKey: env.SETTINGS_KEY,
    sealedSecret: settings.webhookSecret,
  });
}
