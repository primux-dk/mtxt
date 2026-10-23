'use server';

import {
  API_TOKEN_DAYS,
  API_TOKEN_NAME_MAX,
  API_TOKEN_SCOPES,
  cleanDeviceName,
  createApiToken,
  hashRecorderToken,
  listApiTokens,
  newRecorderToken,
  revokeToken,
  type ApiTokenRow,
  type ApiTokenScope,
} from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';

/** An API token as the API tokens dialog shows it. Dates as ISO strings. */
export interface ApiTokenView {
  id: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export type ApiTokensResult = { ok: true; tokens: ApiTokenView[] } | { ok: false };
export type CreateResult =
  | { ok: true; token: string; row: ApiTokenView }
  | {
      ok: false;
      code: 'invalid' | 'too_many' | 'server';
      errors?: { name?: 'required' | 'tooLong' | 'invalid' };
    };
export type RevokeResult = { ok: true } | { ok: false; code: 'not_found' | 'server' };

const view = (r: ApiTokenRow): ApiTokenView => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

/** The signed-in user's own working API tokens. Nobody else's, admins included. */
export async function listMyApiTokens(): Promise<ApiTokensResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false };
  try {
    const { db, installId } = await getAdapters();
    return { ok: true, tokens: (await listApiTokens(db, installId, user.id)).map(view) };
  } catch (error) {
    console.error('Could not list API tokens:', (error as Error).name);
    return { ok: false };
  }
}

/**
 * Makes a token for the signed-in user. The token is answered once and
 * never stored or logged; the row keeps its SHA-256 (docs/spec.md "API").
 */
export async function createMyApiToken(input: {
  name: string;
  scope: string;
  days: number;
}): Promise<CreateResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, code: 'server' };
  const raw = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
  const name = cleanDeviceName(raw);
  if (!name) {
    const reason = !raw ? 'required' : [...raw].length > API_TOKEN_NAME_MAX ? 'tooLong' : 'invalid';
    return { ok: false, code: 'invalid', errors: { name: reason } };
  }
  if (!(API_TOKEN_SCOPES as readonly string[]).includes(input.scope))
    return { ok: false, code: 'invalid' };
  if (!(API_TOKEN_DAYS as readonly number[]).includes(input.days))
    return { ok: false, code: 'invalid' };
  try {
    const { db, installId } = await getAdapters();
    const token = newRecorderToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.days * 86_400_000);
    const created = await createApiToken(db, installId, {
      userId: user.id,
      name,
      scope: input.scope as ApiTokenScope,
      tokenHash: await hashRecorderToken(token),
      expiresAt,
      now,
    });
    if (!created.ok) return { ok: false, code: 'too_many' };
    return {
      ok: true,
      token,
      row: view({
        id: created.id,
        name,
        scope: input.scope as ApiTokenScope,
        createdAt: now,
        expiresAt,
        lastUsedAt: null,
      }),
    };
  } catch (error) {
    console.error('Could not create an API token:', (error as Error).name);
    return { ok: false, code: 'server' };
  }
}

/**
 * Revoke: the token stops working at once. Sets a value, so a retry after a
 * lost answer is a success that writes nothing (behaviour.md rule 2).
 */
export async function revokeMyApiToken(tokenId: string): Promise<RevokeResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, code: 'server' };
  try {
    const { db, installId } = await getAdapters();
    const result = await revokeToken(db, installId, { userId: user.id, tokenId, kind: 'api' });
    return result === 'not_found' ? { ok: false, code: 'not_found' } : { ok: true };
  } catch (error) {
    console.error('Could not revoke an API token:', (error as Error).name);
    return { ok: false, code: 'server' };
  }
}
