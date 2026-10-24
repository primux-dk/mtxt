import {
  hashRecorderToken,
  MCP_ACCESS_LIFETIME_MS,
  MAX_MCP_CONNECTIONS,
  newRecorderToken,
  redeemOAuthCode,
  refreshMcpToken,
  s256,
  type IssueResult,
} from '@mtxt/adapters';
import { getAdapters } from '@/lib/install';
import { mcpOff, oauthContext, oauthError, oauthJson, preflight, readForm } from '@/lib/mcp/http';
import { readClient, resourceAllowed, VERIFIER } from '@/lib/mcp/oauth';

/*
  POST /oauth/token (OAuth 2.1): an authorization code with its PKCE
  verifier for a connection's first tokens, or a refresh token for new
  ones. Public clients: the client id is checked, and the verifier stands
  in for a secret. The access token works an hour; the refresh token is
  replaced by each refresh, and the connection ends 30 days after its last
  one. Only the tokens' SHA-256 is kept (packages/adapters, db/mcp.ts).
*/
export async function POST(request: Request) {
  const context = await oauthContext();
  if (!context) return mcpOff();
  const form = await readForm(request);
  if (typeof form === 'string') return oauthError('invalid_request', form);
  const client = await readClient(context.settingsKey, form.get('client_id'));
  if (!client)
    return oauthError('invalid_client', 'Unknown client_id. Register the client first.', 401);
  const clientId = form.get('client_id')!;
  const origin = new URL(request.url).origin;
  if (!resourceAllowed(form.get('resource'), origin))
    return oauthError('invalid_target', `The resource is ${origin}/mcp.`);

  const { db, installId } = await getAdapters();
  const access = newRecorderToken();
  const refresh = newRecorderToken();
  const [accessHash, refreshHash] = await Promise.all([
    hashRecorderToken(access),
    hashRecorderToken(refresh),
  ]);
  let result: IssueResult;
  const grant = form.get('grant_type');
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    if (!code || !redirectUri || !VERIFIER.test(verifier))
      return oauthError('invalid_request', 'Send code, redirect_uri and the PKCE code_verifier.');
    result = await redeemOAuthCode(db, installId, {
      codeHash: await hashRecorderToken(code),
      clientId,
      redirectUri,
      challenge: await s256(verifier),
      accessHash,
      refreshHash,
    });
  } else if (grant === 'refresh_token') {
    const token = form.get('refresh_token') ?? '';
    if (!token) return oauthError('invalid_request', 'Send the refresh_token.');
    result = await refreshMcpToken(db, installId, {
      refreshHash: await hashRecorderToken(token),
      clientId,
      accessHash,
      nextRefreshHash: refreshHash,
    });
  } else {
    return oauthError(
      'unsupported_grant_type',
      'grant_type is authorization_code or refresh_token.',
    );
  }
  if (!result.ok) {
    return oauthError(
      'invalid_grant',
      result.reason === 'too_many'
        ? `You have ${MAX_MCP_CONNECTIONS} MCP connections. Revoke one under API tokens, then connect again.`
        : 'The code or refresh token is unknown, used, expired or for another client. Connect again.',
    );
  }
  return oauthJson({
    access_token: access,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_LIFETIME_MS / 1000,
    refresh_token: refresh,
    scope: result.scope === 'read_write' ? 'read read_write' : 'read',
  });
}

export const OPTIONS = preflight;
