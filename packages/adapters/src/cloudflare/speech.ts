import type { SpeechModels, WhisperInput, WhisperOutput } from '../speech';

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Base64 without a stack-sized spread: a recording is megabytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Workers AI behind the speech interface. The `AI` binding always runs
 * remotely, so `wrangler dev --local` has none that works; a call then
 * throws and the job records the failure.
 */
export function workersAiSpeech(ai: Ai | undefined): SpeechModels {
  return {
    whisperModel: WHISPER_MODEL,
    async whisper(input: WhisperInput): Promise<WhisperOutput> {
      if (!ai) throw new Error('This Worker has no AI binding.');
      const options = input.gatewayId ? { gateway: { id: input.gatewayId } } : undefined;
      const result = await ai.run(
        WHISPER_MODEL,
        {
          audio: toBase64(input.audio),
          ...(input.language ? { language: input.language } : {}),
          ...(input.initialPrompt ? { initial_prompt: input.initialPrompt } : {}),
          vad_filter: true,
        },
        options,
      );
      return result as WhisperOutput;
    },
  };
}
