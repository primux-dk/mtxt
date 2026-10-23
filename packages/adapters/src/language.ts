/**
 * Language models the platform reaches through Cloudflare: Workers AI text
 * generation on the binding, and the AI Gateway's address for the providers
 * that are called over HTTP (Anthropic, OpenAI, Azure OpenAI). apps/web
 * never touches the `AI` binding; a Docker edition puts a local model or a
 * plain HTTPS base URL behind the same shape.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateInput {
  /** A Workers AI model id, for example `@cf/meta/llama-4-scout-17b-16e-instruct`. */
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** AI Gateway id; the request goes through the gateway when set. */
  gatewayId?: string | null;
}

export interface GenerateOutput {
  text: string;
  /** True when the model stopped at the token cap. */
  truncated?: boolean;
}

/** AI Gateway's provider paths, as `getUrl` names them. */
export type GatewayProvider = 'anthropic' | 'openai' | 'azure-openai';

export interface LanguageModels {
  generate(input: GenerateInput): Promise<GenerateOutput>;
  /**
   * The gateway's base URL for a provider, without a trailing slash:
   * `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic`.
   */
  gatewayUrl(gatewayId: string, provider: GatewayProvider): Promise<string>;
}
