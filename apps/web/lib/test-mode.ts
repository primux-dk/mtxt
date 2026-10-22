import 'server-only';
import { headers } from 'next/headers';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * The e2e run's test hooks (the library's forced `?state=failed`): only in
 * an e2e build (MTXT_E2E_BUILD=1, inlined at build time), with
 * AUTH_TEST_MODE=1 in the Worker's environment, on localhost. The same
 * three locks as packet 2's test sign-in (lib/auth/test-sign-in.ts).
 */
export async function isTestMode(): Promise<boolean> {
  if (process.env.MTXT_E2E_BUILD !== '1') return false;
  const { env } = await getCloudflareContext({ async: true });
  if ((env as { AUTH_TEST_MODE?: string }).AUTH_TEST_MODE !== '1') return false;
  const host = ((await headers()).get('host') ?? '').replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1';
}
