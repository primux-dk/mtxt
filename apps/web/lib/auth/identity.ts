/*
  Pure rules for who may sign in and what the session holds. No server
  imports, so the unit tests and the Auth.js callbacks share them.
*/
import type { IdentityProvider } from '@mtxt/adapters/db/schema';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Entra tenant is pinned by its GUID; `common`, `organizations` and `consumers` are not tenants. */
export const isTenantGuid = (value: string | null | undefined) => GUID.test(value?.trim() ?? '');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address a sign-in may use, or null to refuse it.
 * Entra: the token's `tid` must be the configured tenant. The UPN in
 * `preferred_username` is preferred, since the tenant controls it; the
 * `email` claim is used only when there is no UPN.
 * Google: the Workspace domain in `hd` and a verified address.
 */
export function signInEmail(
  provider: IdentityProvider | null,
  tenant: string | null | undefined,
  profile: Record<string, unknown> | undefined,
): string | null {
  if (!profile || !tenant) return null;
  const claim = (name: string) =>
    typeof profile[name] === 'string' ? (profile[name] as string) : '';
  if (provider === 'entra') {
    if (!isTenantGuid(tenant) || claim('tid').toLowerCase() !== tenant.trim().toLowerCase())
      return null;
    const upn = claim('preferred_username');
    const email = EMAIL.test(upn) ? upn : claim('email');
    return EMAIL.test(email) ? email.toLowerCase() : null;
  }
  if (provider === 'google') {
    const domain = tenant.trim().toLowerCase();
    if (claim('hd').toLowerCase() !== domain || profile.email_verified !== true) return null;
    const email = claim('email').toLowerCase();
    return EMAIL.test(email) ? email : null;
  }
  return null;
}

/** The session token's only fields. Nothing else from the provider is kept. */
export interface SessionToken {
  /** Our users.id. */
  sub: string;
  name: string;
  email: string;
  iat?: number;
  exp?: number;
  /** Milliseconds; the session ends 8 hours after it. */
  signedInAt: number;
}

/**
 * The token Auth.js stores, built from an explicit list. On sign-in `user`
 * is the user row just written; later the previous token is copied field by
 * field. Null once the session is older than `maxAgeSeconds`.
 */
export function sessionToken(
  previous: Record<string, unknown>,
  user: { id: string; name: string; email: string } | null,
  maxAgeSeconds: number,
  now = Date.now(),
): SessionToken | null {
  const token: SessionToken = user
    ? { sub: user.id, name: user.name, email: user.email, signedInAt: now }
    : {
        sub: String(previous.sub ?? ''),
        name: String(previous.name ?? ''),
        email: String(previous.email ?? ''),
        signedInAt: Number(previous.signedInAt ?? 0),
      };
  if (typeof previous.iat === 'number') token.iat = previous.iat;
  if (typeof previous.exp === 'number') token.exp = previous.exp;
  if (!token.sub || !token.email || now - token.signedInAt > maxAgeSeconds * 1000) return null;
  return token;
}

/**
 * Where the login page may send the reader after sign-in: a path on this
 * origin, or /meetings. Control characters (a tab turns `/\t/evil` into
 * `//evil` in some parsers), protocol-relative and absolute URLs fall back.
 */
export function safeReturnTo(value: string | null | undefined, origin: string): string {
  const fallback = '/meetings';
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  try {
    const url = new URL(value, origin);
    if (url.origin !== new URL(origin).origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** The only fields a sign-in request may carry into Auth.js: never authorization parameters. */
const SIGN_IN_FIELDS = new Set(['callbackUrl', 'csrfToken']);

/**
 * A sign-in request with every field outside the allowlist removed from the
 * query and the form body. Auth.js merges a sign-in request's own fields over
 * the provider's authorization parameters, so `client_id=attacker` would
 * otherwise reach the provider. Other Auth.js routes (the callback needs
 * `code` and `state`) pass unchanged.
 */
export async function stripSignInParams(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (!/\/api\/auth\/signin(\/|$)/.test(url.pathname)) return request;
  for (const key of [...url.searchParams.keys()]) {
    if (!SIGN_IN_FIELDS.has(key)) url.searchParams.delete(key);
  }
  const headers = new Headers(request.headers);
  if (request.method !== 'POST') return new Request(url, { method: request.method, headers });
  const form = new URLSearchParams();
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    for (const [key, value] of (await request.formData()).entries()) {
      if (SIGN_IN_FIELDS.has(key) && typeof value === 'string') form.append(key, value);
    }
  }
  headers.set('content-type', 'application/x-www-form-urlencoded');
  headers.delete('content-length');
  return new Request(url, { method: 'POST', headers, body: form.toString() });
}
