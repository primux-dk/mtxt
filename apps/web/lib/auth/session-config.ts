/** 8 hours, from sign-in. Not extended by activity. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

/** Auth.js's own cookie name; the `__Secure-` prefix only over https. */
export const sessionCookieName = (secure: boolean) =>
  `${secure ? '__Secure-' : ''}authjs.session-token`;

/** Paths that answer without a session. Everything else needs one. */
export const isPublicPath = (path: string) =>
  path === '/login' ||
  path.startsWith('/api/auth/') ||
  // The speech-to-text provider's webhook authenticates with the install's secret instead.
  path === '/api/v1/webhooks/assemblyai' ||
  // The recorder's token poll stands on the code verifier; it has no token yet.
  path === '/api/v1/recorder/token' ||
  // A webhook's signed export link is its own grant (lib/webhooks/grant.ts): this one shape only.
  /^\/api\/v1\/export\/[^/]+$/.test(path) ||
  // The MCP server and its OAuth endpoints stand on their own tokens (docs/spec.md "MCP");
  // /oauth/authorize is a page and needs the session like any other.
  isMcpPublicPath(path) ||
  // Only an e2e build has the test sign-in (lib/auth/test-sign-in.ts); the flag is inlined at build time.
  (process.env.MTXT_E2E_BUILD === '1' &&
    (path === '/api/test/sign-in' ||
      // The fake providers (lib/stt/test-hooks.ts) are called by the Worker itself.
      path.startsWith('/api/test/fake-assemblyai/') ||
      path.startsWith('/api/test/fake-elevenlabs/') ||
      path === '/api/test/fake-workers-ai' ||
      path === '/api/test/fake-workers-ai/control' ||
      // And the fake recap model (lib/recap/test-hooks.ts).
      path === '/api/test/fake-recap' ||
      path === '/api/test/fake-recap/control' ||
      // And the webhook receiver the Worker posts deliveries to (lib/webhooks/fake-receiver.ts).
      path === '/api/test/webhook-receiver'));

/**
 * API paths a desktop recorder calls with its bearer token. With an
 * Authorization header the middleware lets these through to the route, which
 * checks the token and answers 401 in the contract's shape when it fails.
 */
export const isRecorderApiPath = (path: string) =>
  path === '/api/v1/recordings' ||
  path.startsWith('/api/v1/recordings/') ||
  path.startsWith('/api/v1/recorder/');

/**
 * The REST API's paths (docs/spec.md "API"), called with a personal API
 * token. With an Authorization header the middleware lets these through to
 * the route, which checks the token, its kind and its scope.
 */
export const isTokenApiPath = (path: string) =>
  path === '/api/v1/meetings' ||
  path === '/api/v1/search' ||
  /^\/api\/v1\/meetings\/[^/]+(\/transcript|\/recap|\/shares(\/[^/]+)?)?$/.test(path);

/**
 * The MCP server's paths that answer without a session: /mcp checks its
 * bearer token itself and answers 401 with the OAuth metadata's address;
 * the metadata, registration, token and revocation endpoints are OAuth's
 * own and take no cookie.
 */
export const isMcpPublicPath = (path: string) =>
  path === '/mcp' ||
  path === '/oauth/register' ||
  path === '/oauth/token' ||
  path === '/oauth/revoke' ||
  /^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/mcp)?$/.test(path);
