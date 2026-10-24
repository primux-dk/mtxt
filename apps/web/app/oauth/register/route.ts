import { mcpOff, oauthContext, oauthError, oauthJson, preflight } from '@/lib/mcp/http';
import { readRegistration, signClient } from '@/lib/mcp/oauth';

/*
  POST /oauth/register: RFC 7591 dynamic client registration, open to any
  MCP client, as the MCP authorization spec expects. Nothing is stored:
  the client id is the client's registration, signed (lib/mcp/oauth.ts).
  Public clients only; the token endpoint takes PKCE instead of a secret.
*/
export async function POST(request: Request) {
  const context = await oauthContext();
  if (!context) return mcpOff();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError('invalid_client_metadata', 'Send the client metadata as JSON.');
  }
  const registration = readRegistration(body);
  if (!registration.ok) return oauthError(registration.error, registration.description);
  const { client } = registration;
  return oauthJson(
    {
      client_id: await signClient(context.settingsKey, client),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read read_write',
    },
    201,
  );
}

export const OPTIONS = preflight;
