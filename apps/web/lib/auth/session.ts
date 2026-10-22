import 'server-only';
import { cache } from 'react';
import { forbidden, redirect } from 'next/navigation';
import { getInstallSettings } from '../install';
import { auth } from './index';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  /** From the settings row's admin list on every request, so a removal applies at once. */
  isAdmin: boolean;
}

/** The signed-in user, or null. Read once per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const [session, settings] = await Promise.all([auth(), getInstallSettings()]);
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  const email = user.email.toLowerCase();
  return {
    id: user.id,
    name: user.name || email,
    email,
    isAdmin: settings.adminEmails.includes(email),
  };
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
  const user = await getSessionUser();
  if (!user)
    return Response.json({ error: 'unauthorized', message: 'Sign in first.' }, { status: 401 });
  if (options.admin && !user.isAdmin) {
    return Response.json({ error: 'forbidden', message: 'Admins only.' }, { status: 403 });
  }
  return user;
}
