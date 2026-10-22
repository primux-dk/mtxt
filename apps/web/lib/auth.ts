import 'server-only';
import { cache } from 'react';
import { eq, and } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { schema } from '@mtxt/adapters';
import { getAdapters } from './install';
import { HttpError } from './http-error';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

/** The header and cookie AUTH_TEST_MODE reads to sign in as another seeded user. */
export const TEST_USER_HEADER = 'x-mtxt-test-user';
export const TEST_USER_COOKIE = 'mtxt_test_user';

/**
 * The signed-in user, or an HttpError 401.
 *
 * TODO(packet 2): replaced by the company login. Until then the only way in
 * is AUTH_TEST_MODE: with `AUTH_TEST_MODE=1` in the Worker's environment
 * (`.dev.vars` or `wrangler dev --var`), never in a deploy, it returns a user
 * seeded by `pnpm db:seed`: `dev`, or the subject named in the
 * `x-mtxt-test-user` header or `mtxt_test_user` cookie. NODE_ENV is
 * "production" in every OpenNext build, `wrangler dev` included, so a request
 * to localhost counts as development too.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const { env } = await getCloudflareContext({ async: true });
  const requestHeaders = await headers();
  const host = (requestHeaders.get('host') ?? '').replace(/:\d+$/, '');
  const local =
    process.env.NODE_ENV !== 'production' || host === 'localhost' || host === '127.0.0.1';
  const testMode = (env as { AUTH_TEST_MODE?: string }).AUTH_TEST_MODE === '1' && local;
  if (!testMode) throw new HttpError(401, 'unauthorized', 'Sign in with the company login.');

  const subject =
    requestHeaders.get(TEST_USER_HEADER) ?? (await cookies()).get(TEST_USER_COOKIE)?.value ?? 'dev';
  const { db, installId } = await getAdapters();
  const user = await db.query.users.findFirst({
    where: and(eq(schema.users.installId, installId), eq(schema.users.oidcSubject, subject)),
  });
  if (!user) {
    throw new HttpError(401, 'unauthorized', `No seeded user "${subject}". Run \`pnpm db:seed\`.`);
  }
  return { id: user.id, name: user.name, email: user.email, isAdmin: user.isAdmin };
});
