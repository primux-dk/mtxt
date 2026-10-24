import { mcpOff, oauthContext, oauthJson, preflight } from '@/lib/mcp/http';
import { protectedResourceMetadata } from '@/lib/mcp/oauth';

/*
  RFC 9728: /.well-known/oauth-protected-resource, and the same under
  /mcp, where an MCP client looks first. It names the install itself as
  the authorization server.
*/
export async function GET(request: Request) {
  const context = await oauthContext();
  if (!context) return mcpOff();
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/\.well-known\/oauth-protected-resource/, '');
  if (suffix !== '' && suffix !== '/mcp') return oauthJson({ error: 'not_found' }, 404);
  return oauthJson(protectedResourceMetadata(url.origin, context.settings.productName), 200, {
    'cache-control': 'public, max-age=300',
  });
}

export const OPTIONS = preflight;
