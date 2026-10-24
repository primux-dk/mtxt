import { mcpOff, oauthContext, oauthJson, preflight } from '@/lib/mcp/http';
import { authorizationServerMetadata } from '@/lib/mcp/oauth';

/*
  RFC 8414: the install's own authorization server. Its issuer is the
  origin, so the document lives at the root; a client that appends the
  MCP path (/.well-known/oauth-authorization-server/mcp) gets the same.
*/
export async function GET(request: Request) {
  const context = await oauthContext();
  if (!context) return mcpOff();
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/\.well-known\/oauth-authorization-server/, '');
  if (suffix !== '' && suffix !== '/mcp') return oauthJson({ error: 'not_found' }, 404);
  return oauthJson(authorizationServerMetadata(url.origin), 200, {
    'cache-control': 'public, max-age=300',
  });
}

export const OPTIONS = preflight;
