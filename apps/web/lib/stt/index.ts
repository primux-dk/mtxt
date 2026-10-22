/*
  The install's provider, from `settings.stt_provider` (docs/decisions.md,
  packet 4). The API key is opened from its sealed column here, at call
  time, and handed to the provider; it is never logged or returned.
*/
import { open, type Settings, type SpeechModels } from '@mtxt/adapters';
import { assemblyAi } from './assemblyai';
import { SttError, type SttProvider, type SttProviderId } from './types';
import { workersAiWhisper } from './workers-ai';

export * from './types';

/** The providers this build implements. The rest stay in the select and are refused at save. */
export const AVAILABLE_PROVIDERS = [
  'assemblyai',
  'workers-ai-whisper',
] as const satisfies readonly SttProviderId[];

export const isAvailable = (provider: string | null | undefined) =>
  (AVAILABLE_PROVIDERS as readonly string[]).includes(provider ?? '');

export interface ProviderDeps {
  settingsKey: string | undefined;
  speech: SpeechModels;
  /** The install's public origin, for AssemblyAI's webhook. */
  publicUrl: string | undefined;
  /** The sealed webhook secret (settings.webhook_secret). */
  webhookSecret: () => Promise<string>;
  /** Test-only overrides; see lib/stt/test-hooks.ts. */
  assemblyAiBaseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export const WEBHOOK_PATH = '/api/v1/webhooks/assemblyai';

export async function providerFor(
  settings: Pick<Settings, 'sttProvider' | 'sttApiKey' | 'aiGatewayId'>,
  deps: ProviderDeps,
): Promise<SttProvider> {
  const id = settings.sttProvider;
  if (!id) throw new SttError('stt_no_provider', 'No speech-to-text provider is chosen.');
  if (!isAvailable(id)) {
    throw new SttError('stt_unavailable', `${id} is not available in this version.`);
  }
  if (id === 'workers-ai-whisper') {
    return workersAiWhisper({ speech: deps.speech, gatewayId: settings.aiGatewayId });
  }
  // assemblyai
  if (!settings.sttApiKey) throw new SttError('stt_auth', 'No AssemblyAI API key is stored.');
  if (!deps.settingsKey) throw new SttError('stt_config', 'SETTINGS_KEY is not set.');
  if (!deps.publicUrl) throw new SttError('stt_config', 'PUBLIC_URL is not set.');
  let apiKey: string;
  let secret: string;
  try {
    apiKey = await open(settings.sttApiKey, 'settings.stt_api_key', deps.settingsKey);
    secret = await open(await deps.webhookSecret(), 'settings.webhook_secret', deps.settingsKey);
  } catch {
    throw new SttError('stt_config', 'A stored secret could not be opened with SETTINGS_KEY.');
  }
  return assemblyAi({
    apiKey,
    webhook: { url: new URL(WEBHOOK_PATH, deps.publicUrl).toString(), secret },
    ...(deps.assemblyAiBaseUrl ? { baseUrl: deps.assemblyAiBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
