/*
  The MCP server's OAuth 2.1 rules (docs/spec.md "MCP"): the metadata
  documents, dynamic client registration, the authorization request's
  checks and the client id. No Next.js and no database here, so the unit
  tests run them as is.

  A client id is a signed statement of the client's own registration:

    mcp1.<base64url JSON { n: name, r: redirect URIs }>.<signature>

  HMAC-SHA256 under a key derived from SETTINGS_KEY for this one use. The
  registration endpoint is open to anyone (RFC 7591, as MCP clients
  expect), so it writes nothing: a client id needs no row, and a flood of
  registrations fills no table. Nothing a client registers is trusted
  beyond its redirect URIs, which an authorization request must match
  exactly, and its name, which the consent page shows as the client's own
  claim.
*/
import { cleanDeviceName, type ApiTokenScope } from '@mtxt/adapters';
import { b64url, derivedKey, fromB64url } from '../derived-key';

export const MCP_PATH = '/mcp';
export const SCOPES = ['read', 'read_write'] as const;
/** At most this many redirect URIs per client, each at most this long. */
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_URI_LENGTH = 512;

const CLIENT_LABEL = 'mtxt:mcp-client:v1';
const CLIENT_ID = /^mcp1\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

/** RFC 9728: where an MCP client learns which authorization server to use. */
export function protectedResourceMetadata(origin: string, productName: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: productName,
  };
}

/** RFC 8414: the install's own authorization server. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The `WWW-Authenticate` of a 401 on /mcp: where the client starts the OAuth flow. */
export const bearerChallenge = (origin: string, error?: 'invalid_token') =>
  `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"` +
  (error ? `, error="${error}"` : '');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Schemes a browser runs or reads itself; never a client's redirect. */
const REFUSED_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'file',
  'filesystem',
  'about',
  'view-source',
  'ftp',
  'ws',
  'wss',
  'mailto',
  'tel',
  'sms',
  'intent',
]);

/**
 * A redirect URI a client may register (RFC 8252, OAuth 2.1): https on any
 * host, http only on a loopback address (a desktop client's local
 * listener), or an app's own scheme (`cursor://...`,
 * `com.example.app:/callback`), but never one the browser would run or
 * read itself (`javascript:`, `data:`, `file:`). No fragment, no
 * credentials.
 */
export function redirectUriAllowed(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return Boolean(url.hostname);
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !REFUSED_SCHEMES.has(scheme);
}

/**
 * Whether a redirect URI in an authorization request matches a registered
 * one: exactly, except that a loopback URI's port may differ (RFC 8252
 * section 7.3), since a desktop client takes whatever port is free.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (asked.protocol !== 'http:' || !LOOPBACK.has(asked.hostname)) return false;
  return registered.some((r) => {
    try {
      const url = new URL(r);
      return (
        url.protocol === 'http:' &&
        url.hostname === asked.hostname &&
        url.pathname === asked.pathname &&
        url.search === asked.search
      );
    } catch {
      return false;
    }
  });
}

export interface Client {
  name: string;
  redirectUris: string[];
}

export async function signClient(settingsKey: string, client: Client): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify({ n: client.name, r: client.redirectUris })));
  const mac = await crypto.subtle.sign(
    'HMAC',
    await derivedKey(settingsKey, CLIENT_LABEL, 'sign'),
    encoder.encode(`mcp1.${body}`),
  );
  return `mcp1.${body}.${b64url(mac)}`;
}

/** The client a client id stands for, or null when it is not one this install signed. */
export async function readClient(settingsKey: string, clientId: unknown): Promise<Client | null> {
  if (typeof clientId !== 'string') return null;
  const match = CLIENT_ID.exec(clientId);
  if (!match) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await derivedKey(settingsKey, CLIENT_LABEL, 'verify'),
      fromB64url(match[2]!),
      encoder.encode(`mcp1.${match[1]}`),
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(match[1]!))) as {
      n?: unknown;
      r?: unknown;
    };
    if (typeof parsed.n !== 'string' || !Array.isArray(parsed.r)) return null;
    if (!parsed.r.every((r) => typeof r === 'string')) return null;
    return { name: parsed.n, redirectUris: parsed.r as string[] };
  } catch {
    return null;
  }
}

export type RegistrationResult =
  | { ok: true; client: Client }
  | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/**
 * RFC 7591 registration metadata, checked. Only public clients with PKCE:
 * a client that asks for a client secret is still registered, as `none`,
 * which RFC 7591 allows the server to choose. The name follows the device
 * name rules; without one, the first redirect URI's host names the client.
 */
export function readRegistration(body: unknown): RegistrationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid_client_metadata', description: 'Send a JSON object.' };
  }
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `redirect_uris is a list of 1 to ${MAX_REDIRECT_URIS} URIs.`,
    };
  }
  const bad = uris.find((u) => !redirectUriAllowed(u));
  if (bad !== undefined) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description:
        "A redirect URI is https, http on a loopback address, or an app's own scheme such as cursor://, at most 512 characters, with no fragment.",
    };
  }
  const grants = meta.grant_types;
  if (
    grants !== undefined &&
    (!Array.isArray(grants) ||
      !grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))
  ) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'grant_types may hold authorization_code and refresh_token only.',
    };
  }
  const responses = meta.response_types;
  if (
    responses !== undefined &&
    (!Array.isArray(responses) || !responses.every((r) => r === 'code'))
  ) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'response_types may hold code only.',
    };
  }
  const given = typeof meta.client_name === 'string' ? meta.client_name.normalize('NFC') : '';
  const name =
    cleanDeviceName(given) ?? cleanDeviceName(new URL(uris[0] as string).host) ?? 'MCP client';
  return { ok: true, client: { name, redirectUris: [...new Set(uris as string[])] } };
}

/** The scope a client asked for: `read_write` when it named it, else `read`. */
export function requestedScope(raw: string | null | undefined): ApiTokenScope | null {
  if (raw === null || raw === undefined || raw.trim() === '') return 'read';
  const words = raw.trim().split(/\s+/);
  if (!words.every((w) => (SCOPES as readonly string[]).includes(w))) return null;
  return words.includes('read_write') ? 'read_write' : 'read';
}

/**
 * RFC 8707: a `resource` an authorization or token request may name. The
 * MCP endpoint, or the install's origin; anything else is another server's
 * and is refused.
 */
export function resourceAllowed(resource: string | null | undefined, origin: string): boolean {
  if (resource === null || resource === undefined || resource === '') return true;
  const strip = (r: string) => r.replace(/\/+$/, '');
  return strip(resource) === `${origin}${MCP_PATH}` || strip(resource) === origin;
}

export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface AuthorizeRequest {
  client: Client;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: ApiTokenScope;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** Not safe to send back: no known client or no registered redirect URI. Shown on the page. */
  | { ok: false; redirect: false; reason: 'client' | 'redirect_uri' }
  /** Sent back to the client's redirect URI as `error`. */
  | {
      ok: false;
      redirect: true;
      redirectUri: string;
      state: string | null;
      error: 'invalid_request' | 'unsupported_response_type' | 'invalid_scope' | 'invalid_target';
      description: string;
    };

/** An authorization request's query, checked in the order RFC 6749 section 4.1.2.1 asks. */
export async function checkAuthorize(
  settingsKey: string,
  query: URLSearchParams,
  origin: string,
): Promise<AuthorizeCheck> {
  const clientId = query.get('client_id') ?? '';
  const client = await readClient(settingsKey, clientId);
  if (!client) return { ok: false, redirect: false, reason: 'client' };
  const redirectUri = query.get('redirect_uri') ?? '';
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri))
    return { ok: false, redirect: false, reason: 'redirect_uri' };
  const state = query.get('state');
  const fail = (
    error: Extract<AuthorizeCheck, { redirect: true }>['error'],
    description: string,
  ): AuthorizeCheck => ({ ok: false, redirect: true, redirectUri, state, error, description });
  for (const key of new Set(query.keys())) {
    if (query.getAll(key).length > 1) return fail('invalid_request', `${key} is given twice.`);
  }
  if (query.get('response_type') !== 'code')
    return fail('unsupported_response_type', 'response_type is code.');
  const challenge = query.get('code_challenge') ?? '';
  if (!CHALLENGE.test(challenge) || query.get('code_challenge_method') !== 'S256')
    return fail(
      'invalid_request',
      'PKCE is required: code_challenge with code_challenge_method S256.',
    );
  const scope = requestedScope(query.get('scope'));
  if (!scope) return fail('invalid_scope', 'The scopes are read and read_write.');
  if (!resourceAllowed(query.get('resource'), origin))
    return fail('invalid_target', `The resource is ${origin}${MCP_PATH}.`);
  return {
    ok: true,
    request: { client, clientId, redirectUri, state, codeChallenge: challenge, scope },
  };
}

/** Where the browser goes after Approve or Cancel: the redirect URI with the answer and `iss`. */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string | null>,
  origin: string,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  url.searchParams.set('iss', origin);
  return url.toString();
}
