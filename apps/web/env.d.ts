/*
  Worker secrets, set with `wrangler secret put` on a deploy and in .dev.vars
  locally. Declared here rather than generated, so `wrangler types` gives the
  same file with or without a local .dev.vars. All optional: the login page
  names the ones a fresh install still lacks.
*/
interface CloudflareEnv {
  AUTH_SECRET?: string;
  /** 32 bytes, base64. Seals the provider secrets stored in the settings row. */
  SETTINGS_KEY?: string;
  /** Read once, on a fresh install, then the settings page is the source. */
  OIDC_PROVIDER?: string;
  OIDC_TENANT_ID?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  /** "1" turns on the e2e test sign-in, in an e2e build on localhost only. */
  AUTH_TEST_MODE?: string;
}
