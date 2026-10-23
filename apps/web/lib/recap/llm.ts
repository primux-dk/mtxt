/*
  The recap model behind one interface (docs/decisions.md, packet 5).
  Workers AI goes through the adapters' binding; Anthropic, OpenAI and
  Azure OpenAI are called with fetch, at the AI Gateway's URL for the
  provider when the install has a gateway, else at the provider's own API.
  The key is opened from its sealed column at call time and never logged.

  A provider's own error text is never read into a message, a log line or a
  row: an error is a fixed reason and the HTTP status (RecapError).

  Plain TypeScript with no Next.js imports: the queue consumer runs it.
*/
import { open, type LanguageModels, type RecapProvider, type Settings } from '@mtxt/adapters';
import { rememberSecret } from '../stt/redact';
import { AZURE_MODEL, NEEDS_RECAP_KEY, recapModel } from './models';

export const RECAP_REASONS = [
  'unauthorised',
  'rate_limited',
  'provider_error',
  'timeout',
  'refused',
  'empty',
  'config',
  'no_transcript',
  'internal',
] as const;
export type RecapReason = (typeof RECAP_REASONS)[number];

export class RecapError extends Error {
  constructor(
    readonly reason: RecapReason,
    readonly retryable = false,
    readonly status?: number,
    readonly call = 'Recap model',
  ) {
    super(`${call}: ${reason}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'RecapError';
  }

  /** What `recaps.failure_reason` stores: the reason and the status, nothing else. */
  get stored(): string {
    return this.status ? `${this.reason}:${this.status}` : this.reason;
  }
}

/** A stored `failure_reason`, read back. */
export function parseRecapReason(stored: string | null | undefined) {
  const [kind, status] = (stored ?? '').split(':');
  if (!(RECAP_REASONS as readonly string[]).includes(kind ?? '')) return null;
  return {
    reason: kind as RecapReason,
    status: status && /^\d{3}$/.test(status) ? status : null,
  };
}

export interface CompletionCall {
  system: string;
  user: string;
  maxTokens: number;
}

export interface Completion {
  text: string;
  truncated: boolean;
}

export interface RecapLlm {
  readonly provider: RecapProvider;
  readonly model: string;
  complete(call: CompletionCall): Promise<Completion>;
}

export interface LlmDeps {
  language: LanguageModels;
  settingsKey: string | undefined;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Per call. 5 minutes: a 4,000-token answer from a slow model, with room. */
  timeoutMs?: number;
}

const TIMEOUT_MS = 5 * 60_000;

/** An HTTP status as a RecapError: 401/403 the key, 429 and 5xx worth a retry, any other 4xx not. */
function statusError(status: number, call: string): RecapError {
  if (status === 401 || status === 403) return new RecapError('unauthorised', false, status, call);
  if (status === 429) return new RecapError('rate_limited', true, status, call);
  if (status >= 500) return new RecapError('provider_error', true, status, call);
  return new RecapError('provider_error', false, status, call);
}

async function post(
  deps: LlmDeps,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  call: string,
): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error).name;
    throw new RecapError(
      name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_error',
      true,
      undefined,
      call,
    );
  }
  if (!response.ok) {
    // The body is the provider's own words; it is not read.
    await response.body?.cancel().catch(() => {});
    throw statusError(response.status, call);
  }
  try {
    return await response.json();
  } catch {
    throw new RecapError('provider_error', false, response.status, call);
  }
}

/** Claude models that take `output_config.effort`; older ones refuse it. */
const EFFORT = /^claude-(opus-[5-9]|sonnet-[5-9]|haiku-[5-9]|fable-|opus-4-[6-9]|sonnet-4-6)/;

function anthropic(deps: LlmDeps, base: string, apiKey: string, model: string): RecapLlm {
  return {
    provider: 'anthropic',
    model,
    async complete(call) {
      const result = (await post(
        deps,
        `${base}/v1/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model,
          max_tokens: call.maxTokens,
          system: call.system,
          messages: [{ role: 'user', content: call.user }],
          // A summary needs little thinking, and thinking counts against the cap.
          ...(EFFORT.test(model) ? { output_config: { effort: 'low' } } : {}),
        },
        'Anthropic',
      )) as { content?: { type?: string; text?: string }[]; stop_reason?: string };
      if (result.stop_reason === 'refusal')
        throw new RecapError('refused', false, 200, 'Anthropic');
      const text = (result.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      return { text, truncated: result.stop_reason === 'max_tokens' };
    },
  };
}

function chatCompletions(
  deps: LlmDeps,
  provider: 'openai' | 'azure-openai',
  url: string,
  headers: Record<string, string>,
  model: string,
): RecapLlm {
  const call = provider === 'openai' ? 'OpenAI' : 'Azure OpenAI';
  return {
    provider,
    model,
    async complete({ system, user, maxTokens }) {
      const result = (await post(
        deps,
        url,
        headers,
        {
          ...(provider === 'openai' ? { model } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_completion_tokens: maxTokens,
        },
        call,
      )) as {
        choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[];
      };
      const choice = result.choices?.[0];
      if (choice?.message?.refusal) throw new RecapError('refused', false, 200, call);
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      return { text, truncated: choice?.finish_reason === 'length' };
    },
  };
}

function workersAi(deps: LlmDeps, model: string, gatewayId: string | null): RecapLlm {
  return {
    provider: 'workers-ai',
    model,
    async complete({ system, user, maxTokens }) {
      // The binding takes no signal: a race against a timer.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RecapError('timeout', true, undefined, 'Workers AI')),
          deps.timeoutMs ?? TIMEOUT_MS,
        );
      });
      try {
        const out = await Promise.race([
          deps.language.generate({
            model,
            maxTokens,
            gatewayId,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          deadline,
        ]);
        return { text: out.text, truncated: Boolean(out.truncated) };
      } catch (error) {
        if (error instanceof RecapError) throw error;
        // The binding's errors carry no status we can rely on; worth one more delivery.
        throw new RecapError('provider_error', true, undefined, 'Workers AI');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The install's recap model, ready to call. */
export async function recapLlm(
  settings: Pick<Settings, 'recapProvider' | 'recapModel' | 'recapApiKey' | 'aiGatewayId'>,
  deps: LlmDeps,
): Promise<RecapLlm> {
  const provider = settings.recapProvider;
  const model = recapModel(provider, settings.recapModel);
  const gatewayId = settings.aiGatewayId || null;
  if (provider === 'workers-ai') return workersAi(deps, model, gatewayId);
  if (!NEEDS_RECAP_KEY.includes(provider)) throw new RecapError('config');
  if (!settings.recapApiKey || !deps.settingsKey) throw new RecapError('unauthorised');
  let apiKey: string;
  try {
    apiKey = await open(settings.recapApiKey, 'settings.recap_api_key', deps.settingsKey);
  } catch {
    throw new RecapError('config');
  }
  rememberSecret(apiKey);
  const gateway = async (name: 'anthropic' | 'openai' | 'azure-openai') => {
    try {
      return gatewayId ? await deps.language.gatewayUrl(gatewayId, name) : null;
    } catch {
      throw new RecapError('config', false, undefined, 'AI Gateway');
    }
  };
  if (provider === 'anthropic') {
    return anthropic(
      deps,
      (await gateway('anthropic')) ?? 'https://api.anthropic.com',
      apiKey,
      model,
    );
  }
  if (provider === 'openai') {
    const base = (await gateway('openai')) ?? 'https://api.openai.com/v1';
    return chatCompletions(
      deps,
      'openai',
      `${base}/chat/completions`,
      {
        authorization: `Bearer ${apiKey}`,
      },
      model,
    );
  }
  // Azure OpenAI: the model field is `resource/deployment`.
  const azure = AZURE_MODEL.exec(model);
  if (!azure) throw new RecapError('config');
  const [, resource, deployment] = azure;
  const base =
    (await gateway('azure-openai'))?.concat(`/${resource}/${deployment}`) ??
    `https://${resource}.openai.azure.com/openai/deployments/${deployment}`;
  return chatCompletions(
    deps,
    'azure-openai',
    `${base}/chat/completions?api-version=2024-10-21`,
    { 'api-key': apiKey },
    model,
  );
}
