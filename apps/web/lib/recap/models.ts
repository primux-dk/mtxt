/*
  The recap model per provider: the default id when the settings leave it
  empty, and how much transcript fits before the job summarises in parts.
  Checked 2026-10-23 (docs/decisions.md, packet 5).
*/
import type { RecapProvider } from '@mtxt/adapters';

export const RECAP_PROVIDER_IDS = [
  'workers-ai',
  'anthropic',
  'openai',
  'azure-openai',
] as const satisfies readonly RecapProvider[];

/**
 * Workers AI: Llama 4 Scout, the newest Llama in the catalogue, 131,000
 * tokens of context, so most meetings draft in one call. Anthropic: Claude
 * Opus 5.5. OpenAI: gpt-5.4. Azure OpenAI has no default: the model field
 * names the resource and the deployment (`resource/deployment`).
 */
export const DEFAULT_RECAP_MODEL: Record<RecapProvider, string> = {
  'workers-ai': '@cf/meta/llama-4-scout-17b-16e-instruct',
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.4',
  'azure-openai': '',
};

export const NEEDS_RECAP_KEY: readonly RecapProvider[] = ['anthropic', 'openai', 'azure-openai'];

/** The output cap of every recap call (the packet's 4,000 tokens). */
export const RECAP_MAX_TOKENS = 4000;
/** A part's summary, when a long transcript is summarised first. */
export const SUMMARY_MAX_TOKENS = 1200;

/** Known context windows, in tokens. Anything else gets the provider's floor. */
const CONTEXT: Record<string, number> = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': 131_000,
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24_000,
  '@cf/meta/llama-3.1-8b-instruct-fp8': 32_000,
};
const FLOOR: Record<RecapProvider, number> = {
  'workers-ai': 24_000,
  anthropic: 200_000,
  openai: 128_000,
  'azure-openai': 128_000,
};

export function contextTokens(provider: RecapProvider, model: string): number {
  return CONTEXT[model] ?? FLOOR[provider];
}

export function recapModel(provider: RecapProvider, model: string | null | undefined): string {
  return model?.trim() || DEFAULT_RECAP_MODEL[provider];
}

/** A model id as the settings page takes it: printable, no spaces, at most 200 characters. */
export const MODEL_ID = /^[A-Za-z0-9@._:/-]{1,200}$/;
/** Azure OpenAI: `resource/deployment`, both Azure names. */
export const AZURE_MODEL = /^([a-z0-9][a-z0-9-]{1,62})\/([A-Za-z0-9._-]{1,64})$/;
