/*
  The e2e test sign-in. Real OIDC cannot run headless, so the e2e build gets a
  route that sets a session for a given email and admin flag.

  Three locks keep it out of a real install:
  1. Build: the route file is `route.e2e.ts`, which Next.js only treats as a
     route when MTXT_E2E_BUILD=1 adds `e2e.ts` to pageExtensions. A normal
     build has no such route.
  2. Bundle: this module throws on import in a production bundle that is not
     an e2e build, so a route that reaches it by mistake fails `next build`
     while it collects page data. test/test-sign-in.test.ts imports it with
     NODE_ENV=production to prove it.
  3. Runtime: it answers only with AUTH_TEST_MODE=1 (.dev.vars or the e2e env
     file, never a Worker secret) and only on localhost.
*/
import { encode } from 'next-auth/jwt';
import {
  AccountConflictError,
  findUser,
  readSettings,
  recordSignIn,
  saveSettings,
} from '@mtxt/adapters';
import { sessionToken } from './identity';
import { getAdapters, getEnv } from '../install';
import { SESSION_MAX_AGE, sessionCookieName } from './session-config';

if (process.env.NODE_ENV === 'production' && process.env.MTXT_E2E_BUILD !== '1') {
  throw new Error(
    'The e2e test sign-in is in a production bundle. Only an MTXT_E2E_BUILD=1 build may include it.',
  );
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function testSignIn(request: Request): Promise<Response> {
  const env = await getEnv();
  const url = new URL(request.url);
  if (env.AUTH_TEST_MODE !== '1' || !LOCAL.has(url.hostname) || !env.AUTH_SECRET) {
    return new Response('Not found', { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    admin?: boolean;
    /** Defaults to `test|<email>`; a second subject for the same address reproduces a conflict. */
    subject?: string;
  };
  const email = body.email?.trim().toLowerCase();
  if (!email) return Response.json({ error: 'email is required' }, { status: 400 });

  const { db, installId } = await getAdapters();
  // The same path a real sign-in takes, then the admin flag the test asked for.
  let id: string;
  try {
    ({ id } = await recordSignIn(db, installId, {
      subject: body.subject ?? `test|${email}`,
      email,
      name: body.name ?? email,
    }));
  } catch (error) {
    if (error instanceof AccountConflictError) {
      return Response.json({ error: 'account_conflict' }, { status: 409 });
    }
    throw error;
  }
  // With no flag the sign-in decides, as a real one does (the first user becomes admin).
  // With a flag, the admin list is set to match; saving it also sets users.is_admin.
  if (typeof body.admin === 'boolean') {
    const settings = await readSettings(db, installId);
    const others = settings.adminEmails.filter((e) => e !== email);
    await saveSettings(db, installId, {
      productName: settings.productName,
      adminEmails: body.admin ? [...others, email] : others,
    });
  }
  const user = (await findUser(db, installId, id))!;

  const secure = url.protocol === 'https:';
  const cookie = sessionCookieName(secure);
  const token = await encode({
    secret: env.AUTH_SECRET,
    salt: cookie,
    maxAge: SESSION_MAX_AGE,
    // The same allowlisted shape the Auth.js jwt callback writes.
    token: { ...sessionToken({}, user, SESSION_MAX_AGE)! },
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append(
    'set-cookie',
    `${cookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure ? '; Secure' : ''}`,
  );
  return new Response(JSON.stringify({ id: user.id, email: user.email, isAdmin: user.isAdmin }), {
    headers,
  });
}
