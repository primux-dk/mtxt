import 'server-only';
import { getEnv, getInstallSettings } from '../install';

/*
  What the OAuth endpoints share (app/oauth, app/.well-known): CORS for
  browser-based MCP clients (the endpoints take no cookie, so any origin
  may call them), `no-store` on every answer, the RFC 6749 error shape,
  and 404 for all of them while "MCP server" is off in the settings.
*/

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

export const oauthJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...CORS, ...headers } });

export const oauthError = (error: string, description: string, status = 400) =>
  oauthJson({ error, error_description: description }, status);

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export const mcpOff = () =>
  oauthJson(
    { error: 'not_found', error_description: 'The MCP server is off for this install.' },
    404,
  );

/** The settings and the key the OAuth endpoints need, or null while MCP is off. */
export async function oauthContext() {
  const [settings, env] = await Promise.all([getInstallSettings(), getEnv()]);
  if (!settings.mcpEnabled) return null;
  if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set.');
  return { settings, settingsKey: env.SETTINGS_KEY };
}

/** A form body (RFC 6749 section 3.2), with each parameter at most once. */
export async function readForm(request: Request): Promise<URLSearchParams | string> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded'))
    return 'Send the parameters as application/x-www-form-urlencoded.';
  const form = new URLSearchParams(await request.text());
  for (const key of new Set(form.keys())) {
    if (form.getAll(key).length > 1) return `${key} is given twice.`;
  }
  return form;
}

/** The install's origin as the browser sees it, for a page or a server action (as the login page works it out). */
export async function pageOrigin(): Promise<string> {
  const { headers } = await import('next/headers');
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}
