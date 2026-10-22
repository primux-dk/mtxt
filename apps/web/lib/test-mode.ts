import 'server-only';
import { headers } from 'next/headers';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * AUTH_TEST_MODE: `AUTH_TEST_MODE=1` in the Worker's environment
 * (`.dev.vars`, or `wrangler dev --var`), and a development request.
 * NODE_ENV is "production" in every OpenNext build, `wrangler dev`
 * included, so a request to localhost counts as development too. A deployed
 * Worker never answers on localhost, and no deploy sets the variable.
 */
export async function isTestMode(): Promise<boolean> {
  const { env } = await getCloudflareContext({ async: true });
  if ((env as { AUTH_TEST_MODE?: string }).AUTH_TEST_MODE !== '1') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  const host = ((await headers()).get('host') ?? '').replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1';
}
