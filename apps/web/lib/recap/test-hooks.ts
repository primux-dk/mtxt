/*
  The e2e run's stand-in for the recap model: a RecapLlm that posts to the
  fake route (lib/recap/fake-llm.ts). The queue consumer is bundled by
  wrangler, so this module is imported only behind the MTXT_E2E_BUILD define
  (lib/recap/deps.ts), and it answers only with AUTH_TEST_MODE=1 and a
  localhost URL in RECAP_FAKE_URL.
*/
import { RecapError, type RecapLlm } from './llm';

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RecapTestEnv {
  AUTH_TEST_MODE?: string;
  RECAP_FAKE_URL?: string;
}

/** The fake recap model, in a test run only. */
export function fakeRecapLlm(env: RecapTestEnv): RecapLlm | undefined {
  if (env.AUTH_TEST_MODE !== '1' || !env.RECAP_FAKE_URL) return undefined;
  let url: URL;
  try {
    url = new URL(env.RECAP_FAKE_URL);
  } catch {
    return undefined;
  }
  if (!LOCAL.has(url.hostname)) return undefined;
  return {
    provider: 'workers-ai',
    model: 'fake-recap',
    async complete(call) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: call.system, user: call.user, max_tokens: call.maxTokens }),
      });
      if (response.status === 401) throw new RecapError('unauthorised', false, 401, 'fake recap');
      if (!response.ok) throw new RecapError('provider_error', true, response.status, 'fake recap');
      return (await response.json()) as { text: string; truncated: boolean };
    },
  };
}
