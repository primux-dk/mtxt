import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { forbidden, redirect } from 'next/navigation';
import {
  bearerToken,
  findRecorderUser,
  findUser,
  hashRecorderToken,
  type User,
} from '@mtxt/adapters';
import { getAdapters } from '../install';
import { auth } from './index';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** The user row's is_admin, kept from the admin list at sign-in and on every save of the list. */
  isAdmin: boolean;
}

/**
 * The signed-in user, or null. Read once per request. The cookie's subject is
 * resolved to the current user row, and the row decides: its email, its name
 * and its is_admin. The email in the cookie is never trusted, so a cookie
 * issued before an email change or an admin removal carries no stale rights.
 * A cookie whose user row is gone counts as signed out.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const [session, { db, installId }] = await Promise.all([auth(), getAdapters()]);
  const id = session?.user?.id;
  if (!id) return null;
  const user = await findUser(db, installId, id);
  return user ? sessionUser(user) : null;
});

const sessionUser = (user: User): SessionUser => ({
  id: user.id,
  name: user.name || user.email,
  email: user.email,
  isAdmin: user.isAdmin,
});

/**
 * The caller of an API route: a desktop recorder's bearer token when the
 * request carries an Authorization header, else the session cookie. A header
 * that is there but not a working token is no one, cookie or not, so a
 * recorder with a revoked token gets 401 rather than someone's session. The
 * token's user row decides, the same as for a cookie (docs/spec.md
 * "Recorder connection").
 */
export const getApiUser = cache(async (): Promise<SessionUser | null> => {
  const authorization = (await headers()).get('authorization');
  if (authorization === null) return getSessionUser();
  const token = bearerToken(authorization);
  if (!token) return null;
  const { db, installId } = await getAdapters();
  const found = await findRecorderUser(db, installId, await hashRecorderToken(token));
  return found ? sessionUser(found.user) : null;
});

/** A page that needs a session sends the reader to the login page, and back after. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(returnTo ? `/login?callbackUrl=${encodeURIComponent(returnTo)}` : '/login');
  return user;
}

/** An admin-only page answers 403 with the "Admins only" page, not a redirect. */
export async function requireAdmin(returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!user.isAdmin) forbidden();
  return user;
}

/** For route handlers: the user, or the 401 or 403 JSON response to return. */
export async function apiUser(options: { admin?: boolean } = {}): Promise<SessionUser | Response> {
  const user = await getApiUser();
  if (!user)
    return Response.json({ error: 'unauthorized', message: 'Sign in first.' }, { status: 401 });
  if (options.admin && !user.isAdmin) {
    return Response.json({ error: 'forbidden', message: 'Admins only.' }, { status: 403 });
  }
  return user;
}
