/*
  The e2e run's stand-ins for the providers: a fake AssemblyAI and a fake
  Workers AI, served by routes that exist only in an e2e build
  (the route.e2e.ts files under app/api/test). The queue consumer is bundled by
  wrangler, not by Next.js, so the build-time flag the test sign-in uses
  does not reach it; these overrides are honoured only when the Worker runs
  with AUTH_TEST_MODE=1 and the URL is on localhost. A deployed install has
  neither, and has no fake routes to reach.
*/
import type { SpeechModels, WhisperOutput } from '@mtxt/adapters';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

function localUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return LOCAL.has(url.hostname) ? url.toString().replace(/\/$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export interface TestEnv {
  AUTH_TEST_MODE?: string;
  ASSEMBLYAI_BASE_URL?: string;
  WORKERS_AI_FAKE_URL?: string;
}

/** The fake AssemblyAI's base URL, in a test run only. */
export function fakeAssemblyAiUrl(env: TestEnv): string | undefined {
  return env.AUTH_TEST_MODE === '1' ? localUrl(env.ASSEMBLYAI_BASE_URL) : undefined;
}

/** A Whisper that answers from the fake route, in a test run only. */
export function fakeSpeech(env: TestEnv): SpeechModels | undefined {
  const url = env.AUTH_TEST_MODE === '1' ? localUrl(env.WORKERS_AI_FAKE_URL) : undefined;
  if (!url) return undefined;
  return {
    whisperModel: '@cf/openai/whisper-large-v3-turbo',
    async whisper(input) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bytes: input.audio.byteLength,
          language: input.language ?? null,
          initial_prompt: input.initialPrompt ?? null,
          gateway: input.gatewayId ?? null,
        }),
      });
      if (!response.ok) throw new Error(`fake Workers AI: HTTP ${response.status}`);
      return (await response.json()) as WhisperOutput;
    },
  };
}

/** Both overrides at once, for lib/transcription/deps.ts. */
export function e2eOverrides(env: TestEnv) {
  return { speech: fakeSpeech(env), assemblyAiBaseUrl: fakeAssemblyAiUrl(env) };
}
