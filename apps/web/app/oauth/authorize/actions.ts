'use server';

import {
  countMcpConnections,
  createOAuthCode,
  hashRecorderToken,
  MAX_MCP_CONNECTIONS,
  newRecorderToken,
} from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';
import { oauthContext, pageOrigin } from '@/lib/mcp/http';
import { checkAuthorize, redirectWith } from '@/lib/mcp/oauth';

/** Where the consent form sends the browser next, or what it shows when it cannot. */
export type ConsentState =
  | { redirectTo: string }
  | { error: 'too_many' | 'invalid' | 'signed_out' | 'server' | 'off' }
  | null;

/**
 * Approve and Cancel on /oauth/authorize. Server actions, so Next.js checks
 * the request's Origin against the host (CSRF). Each checks the request
 * again from the form's copy of the query, since the page's check is
 * not carried over. Approve writes a code for the scope the user chose;
 * Cancel answers the client `access_denied`. Either way the browser goes
 * back to the client's registered redirect URI.
 */
async function decide(kind: 'approve' | 'deny', form: FormData): Promise<ConsentState> {
  const context = await oauthContext().catch(() => null);
  if (!context) return { error: 'off' };
  const origin = await pageOrigin();
  const check = await checkAuthorize(
    context.settingsKey,
    new URLSearchParams(String(form.get('query') ?? '')),
    origin,
  );
  if (!check.ok) return { error: 'invalid' };
  const { request } = check;
  const user = await getSessionUser();
  if (!user) return { error: 'signed_out' };
  if (kind === 'deny') {
    return {
      redirectTo: redirectWith(
        request.redirectUri,
        { error: 'access_denied', error_description: 'The user cancelled.', state: request.state },
        origin,
      ),
    };
  }
  const scope = form.get('scope') === 'read_write' ? 'read_write' : 'read';
  try {
    const { db, installId } = await getAdapters();
    if ((await countMcpConnections(db, installId, user.id)) >= MAX_MCP_CONNECTIONS)
      return { error: 'too_many' };
    const code = newRecorderToken();
    await createOAuthCode(db, installId, {
      codeHash: await hashRecorderToken(code),
      userId: user.id,
      clientId: request.clientId,
      clientName: request.client.name,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope,
    });
    return {
      redirectTo: redirectWith(request.redirectUri, { code, state: request.state }, origin),
    };
  } catch (error) {
    console.error('Could not store the OAuth code:', (error as Error).name);
    return { error: 'server' };
  }
}

export async function approveMcp(_previous: ConsentState, form: FormData) {
  return decide('approve', form);
}

export async function cancelMcp(_previous: ConsentState, form: FormData) {
  return decide('deny', form);
}
