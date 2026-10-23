import { getApiUser } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';
import { runInMcp } from '@/lib/mcp/context';
import { bearerChallenge } from '@/lib/mcp/oauth';
import { mcpHandler } from '@/lib/mcp/server';

/*
  /mcp (docs/spec.md "MCP"): the MCP server, Streamable HTTP. The caller is
  an MCP connection's access token, from the install's own OAuth server
  (app/oauth). Without one the answer is 401 with the protected resource
  metadata's address, where an MCP client starts the OAuth flow. With
  "MCP server" off in the settings, /mcp is 404. Bearer only, never the
  session cookie, so any origin may call it.
*/

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
};

const withCors = (response: Response) => {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
};

async function serve(request: Request): Promise<Response> {
  const settings = await getInstallSettings();
  if (!settings.mcpEnabled) {
    return Response.json(
      { error: { code: 'not_found', message: 'The MCP server is off for this install.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }
  const origin = new URL(request.url).origin;
  const user = await getApiUser();
  if (!user || user.token?.kind !== 'mcp') {
    const sent = request.headers.has('authorization');
    return withCors(
      Response.json(
        {
          error: {
            code: 'unauthorized',
            message: 'Connect through OAuth: the protected resource metadata names the server.',
          },
        },
        {
          status: 401,
          headers: {
            'cache-control': 'no-store',
            'www-authenticate': bearerChallenge(origin, sent ? 'invalid_token' : undefined),
          },
        },
      ),
    );
  }
  const token = user.token;
  const response = await runInMcp({ client: token.name }, () =>
    mcpHandler(origin, settings.productName).fetch(request, {
      authInfo: {
        token: '',
        clientId: token.id,
        scopes: token.scope === 'read_write' ? ['read', 'read_write'] : ['read'],
      },
    }),
  );
  return withCors(response);
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers':
        'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
      'access-control-max-age': '86400',
    },
  });
}
