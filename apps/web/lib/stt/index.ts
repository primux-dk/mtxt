/*
  The install's provider, from `settings.stt_provider` (docs/decisions.md,
  packet 4). The API key is opened from its sealed column here, at call
  time, and handed to the provider; it is never logged or returned.
*/
import { open, type GatewayProvider, type Settings, type SpeechModels } from '@mtxt/adapters';
import { assemblyAi } from './assemblyai';
import { elevenLabs } from './elevenlabs';
import { rememberSecret } from './redact';
import { SttError, type SttProvider, type SttProviderId } from './types';
import { workersAiWhisper } from './workers-ai';

export * from './types';

/** The providers this build implements. The rest stay in the select and are refused at save. */
export const AVAILABLE_PROVIDERS = [
  'assemblyai',
  'elevenlabs',
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
  /** http://localhost:<port> is a valid PUBLIC_URL only in the e2e build or local wrangler. */
  allowLocalPublicUrl?: boolean;
  /** AI Gateway's base URL for a provider, from the binding (packages/adapters, language). */
  gatewayUrl?: (gatewayId: string, provider: GatewayProvider) => Promise<string>;
  /** Test-only overrides; see lib/stt/test-hooks.ts. */
  assemblyAiBaseUrl?: string;
  elevenLabsBaseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export const WEBHOOK_PATH = '/api/v1/webhooks/assemblyai';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The webhook's address from PUBLIC_URL: an https origin with no
 * credentials, path, query or fragment. http://localhost:<port> and
 * http://127.0.0.1:<port> pass only when `allowLocal` (the e2e build or
 * local wrangler). Anything else is a configuration error.
 */
export function webhookUrl(publicUrl: string | undefined, allowLocal = false): string {
  const bad = () => new SttError('stt_config', 'config', false, undefined, 'PUBLIC_URL');
  if (!publicUrl) throw bad();
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw bad();
  }
  const bare =
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !/[?#]/.test(publicUrl);
  const https = url.protocol === 'https:';
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && url.port !== '';
  if (!bare || !(https || (local && allowLocal))) throw bad();
  return `${url.origin}${WEBHOOK_PATH}`;
}

export async function providerFor(
  settings: Pick<Settings, 'sttProvider' | 'sttApiKey' | 'aiGatewayId'>,
  deps: ProviderDeps,
): Promise<SttProvider> {
  const id = settings.sttProvider;
  if (!id) throw new SttError('stt_no_provider', 'config');
  if (!isAvailable(id)) throw new SttError('stt_unavailable', 'config');
  if (id === 'workers-ai-whisper') {
    return workersAiWhisper({ speech: deps.speech, gatewayId: settings.aiGatewayId });
  }
  if (!settings.sttApiKey) throw new SttError('stt_auth', 'unauthorised');
  if (!deps.settingsKey) throw new SttError('stt_config', 'config');
  if (id === 'elevenlabs') {
    let apiKey: string;
    try {
      apiKey = await open(settings.sttApiKey, 'settings.stt_api_key', deps.settingsKey);
    } catch {
      throw new SttError('stt_config', 'config');
    }
    rememberSecret(apiKey);
    let gatewayBase: string | null = null;
    if (settings.aiGatewayId && !deps.elevenLabsBaseUrl) {
      try {
        if (!deps.gatewayUrl) throw new Error('No gateway address.');
        gatewayBase = await deps.gatewayUrl(settings.aiGatewayId, 'elevenlabs');
      } catch {
        throw new SttError('stt_config', 'config', false, undefined, 'AI Gateway');
      }
    }
    return elevenLabs({
      apiKey,
      gatewayBase,
      ...(deps.elevenLabsBaseUrl ? { baseUrl: deps.elevenLabsBaseUrl } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  }
  // assemblyai
  const url = webhookUrl(deps.publicUrl, deps.allowLocalPublicUrl);
  let apiKey: string;
  let secret: string;
  try {
    apiKey = await open(settings.sttApiKey, 'settings.stt_api_key', deps.settingsKey);
    secret = await open(await deps.webhookSecret(), 'settings.webhook_secret', deps.settingsKey);
  } catch {
    throw new SttError('stt_config', 'config');
  }
  rememberSecret(apiKey);
  rememberSecret(secret);
  return assemblyAi({
    apiKey,
    webhook: { url, secret },
    ...(deps.assemblyAiBaseUrl ? { baseUrl: deps.assemblyAiBaseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
