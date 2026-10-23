import type { GatewayProvider, GenerateInput, GenerateOutput, LanguageModels } from '../language';

/** What a Workers AI text model answers: `response` (Llama), or chat-completions `choices` (newer models). */
type WorkersAiText = {
  response?: unknown;
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  usage?: { completion_tokens?: number };
};

/**
 * Workers AI behind the language interface. The `AI` binding always runs
 * remotely, so `wrangler dev --local` has none that works; a call then
 * throws and the recap job records the failure.
 */
export function workersAiLanguage(ai: Ai | undefined): LanguageModels {
  return {
    async generate(input: GenerateInput): Promise<GenerateOutput> {
      if (!ai) throw new Error('This Worker has no AI binding.');
      const options = input.gatewayId ? { gateway: { id: input.gatewayId } } : undefined;
      const result = (await ai.run(
        input.model as Parameters<Ai['run']>[0],
        { messages: input.messages, max_tokens: input.maxTokens } as never,
        options,
      )) as WorkersAiText;
      const choice = result.choices?.[0];
      const text =
        typeof result.response === 'string'
          ? result.response
          : typeof choice?.message?.content === 'string'
            ? choice.message.content
            : null;
      if (text === null) throw new Error('Workers AI answered without text.');
      return {
        text,
        truncated:
          choice?.finish_reason === 'length' ||
          (result.usage?.completion_tokens ?? 0) >= input.maxTokens,
      };
    },
    async gatewayUrl(gatewayId: string, provider: GatewayProvider) {
      if (!ai) throw new Error('This Worker has no AI binding.');
      return (await ai.gateway(gatewayId).getUrl(provider)).replace(/\/$/, '');
    },
  };
}
