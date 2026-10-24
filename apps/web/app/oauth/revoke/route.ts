import { hashRecorderToken, revokeMcpToken } from '@mtxt/adapters';
import { getAdapters } from '@/lib/install';
import { mcpOff, oauthContext, oauthError, preflight, readForm } from '@/lib/mcp/http';
import { readClient } from '@/lib/mcp/oauth';

/*
  POST /oauth/revoke (RFC 7009): a client ends its own connection with its
  access or refresh token. An unknown token is 200 as well, so the answer
  says nothing about which tokens exist.
*/
export async function POST(request: Request) {
  const context = await oauthContext();
  if (!context) return mcpOff();
  const form = await readForm(request);
  if (typeof form === 'string') return oauthError('invalid_request', form);
  const clientId = form.get('client_id');
  if (!(await readClient(context.settingsKey, clientId)))
    return oauthError('invalid_client', 'Unknown client_id.', 401);
  const token = form.get('token') ?? '';
  if (!token) return oauthError('invalid_request', 'Send the token.');
  const { db, installId } = await getAdapters();
  await revokeMcpToken(db, installId, {
    tokenHash: await hashRecorderToken(token),
    clientId: clientId!,
  });
  return new Response(null, {
    status: 200,
    headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
  });
}

export const OPTIONS = preflight;
