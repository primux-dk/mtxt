import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cloudflareAdapters, readSettings } from '@mtxt/adapters';
import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_MAX_AGE, sessionCookieName } from './lib/auth/session-config';

/*
  The gate: every page and API route needs a session, except the login page
  and Auth.js's own routes. Pages without one go to the login page and come
  back after; API routes answer 401 JSON. /settings also needs the address on
  the admin list; anyone else gets the "Admins only" page with status 403.
  Pages and routes still read the user and the admin list themselves.
*/
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (isPublicPath(path)) return NextResponse.next();

  const secure = request.nextUrl.protocol === 'https:';
  const { env } = await getCloudflareContext({ async: true });
  const token = env.AUTH_SECRET
    ? await getToken({
        req: request,
        secret: env.AUTH_SECRET,
        secureCookie: secure,
        salt: sessionCookieName(secure),
      })
    : null;
  const fresh = token && Date.now() - Number(token.signedInAt ?? 0) <= SESSION_MAX_AGE * 1000;
  if (fresh) {
    if (path === '/settings' || path.startsWith('/settings/')) {
      const { db, installId } = cloudflareAdapters(env);
      const { adminEmails } = await readSettings(db, installId);
      if (!adminEmails.includes(String(token.email ?? '').toLowerCase())) {
        return NextResponse.rewrite(new URL('/admins-only', request.url), { status: 403 });
      }
    }
    return NextResponse.next();
  }

  if (path.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized', message: 'Sign in first.' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  if (path !== '/') login.searchParams.set('callbackUrl', path + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Next.js's own static files skip the gate; /design's files do not.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
