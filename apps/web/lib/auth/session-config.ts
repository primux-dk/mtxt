/** 8 hours, from sign-in. Not extended by activity. */
export const SESSION_MAX_AGE = 8 * 60 * 60;

/** Auth.js's own cookie name; the `__Secure-` prefix only over https. */
export const sessionCookieName = (secure: boolean) =>
  `${secure ? '__Secure-' : ''}authjs.session-token`;

/** Paths that answer without a session. Everything else needs one. */
export const isPublicPath = (path: string) =>
  path === '/login' ||
  path.startsWith('/api/auth/') ||
  // Only an e2e build has the test sign-in (lib/auth/test-sign-in.ts); the flag is inlined at build time.
  (process.env.MTXT_E2E_BUILD === '1' && path === '/api/test/sign-in');
