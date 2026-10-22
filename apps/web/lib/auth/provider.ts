import 'server-only';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { open, type IdentityProvider, type Settings } from '@mtxt/adapters';
import { identityProviderFromEnv } from '../install';

/** Auth.js provider ids, as they appear in the callback URL. */
export const PROVIDER_IDS: Record<IdentityProvider, string> = {
  entra: 'microsoft-entra-id',
  google: 'google',
};

/** The brand the sign-in button names. A product name, so it is not translated. */
export const PROVIDER_BRANDS: Record<IdentityProvider, string> = {
  entra: 'Microsoft',
  google: 'Google',
};

export type LoginSetup =
  | { kind: 'ready'; provider: IdentityProvider }
  /** Names of the Worker secrets a fresh install still lacks. */
  | { kind: 'missing'; names: string[] }
  /** The stored client secret cannot be opened with this SETTINGS_KEY. */
  | { kind: 'broken' };

/** What the login page can offer, from the settings row and the Worker's secrets. */
export async function loginSetup(settings: Settings, env: CloudflareEnv): Promise<LoginSetup> {
  const names: string[] = [];
  if (!env.AUTH_SECRET) names.push('AUTH_SECRET');
  if (!env.SETTINGS_KEY) names.push('SETTINGS_KEY');
  if (!settings.identityProvider || !settings.oidcClientId || !settings.oidcClientSecret) {
    const oidc = [
      'OIDC_PROVIDER',
      'OIDC_TENANT_ID',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
    ] as const;
    const unset = oidc.filter((name) => !env[name]?.trim());
    // Every value is there, but the provider name is not one we know.
    if (unset.length === 0 && env.SETTINGS_KEY && !identityProviderFromEnv(env.OIDC_PROVIDER)) {
      unset.push('OIDC_PROVIDER');
    }
    names.push(...unset);
  }
  if (names.length) return { kind: 'missing', names };
  return (await clientSecret(settings, env)) === null
    ? { kind: 'broken' }
    : { kind: 'ready', provider: settings.identityProvider! };
}

async function clientSecret(settings: Settings, env: CloudflareEnv): Promise<string | null> {
  if (!settings.oidcClientSecret || !env.SETTINGS_KEY) return null;
  try {
    return await open(settings.oidcClientSecret, env.SETTINGS_KEY);
  } catch (error) {
    console.error('Could not open the stored identity provider secret:', (error as Error).message);
    return null;
  }
}

/** The one configured provider for Auth.js, or none while the install is not set up. */
export async function authProvider(settings: Settings, env: CloudflareEnv) {
  const secret = await clientSecret(settings, env);
  const clientId = settings.oidcClientId;
  const tenant = settings.oidcTenantId?.trim();
  if (!secret || !clientId || !tenant) return null;

  if (settings.identityProvider === 'entra') {
    return MicrosoftEntraID({
      clientId,
      clientSecret: secret,
      // A tenant-specific issuer: only accounts in this directory get a token.
      issuer: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0`,
      // No Graph photo: the default profile fetches one into the session cookie.
      authorization: { params: { scope: 'openid profile email' } },
      profile: (p) => ({
        id: p.sub,
        name: p.name ?? null,
        email: (p.email ?? (p as { preferred_username?: string }).preferred_username) || null,
      }),
    });
  }
  if (settings.identityProvider === 'google') {
    return Google({
      clientId,
      clientSecret: secret,
      // `hd` narrows Google's account picker; the sign-in callback enforces it.
      authorization: { params: { hd: tenant.toLowerCase(), prompt: 'select_account' } },
    });
  }
  return null;
}

/**
 * Google answers for every Google account, so sign-in checks the Workspace
 * domain and a verified address. Entra's tenant issuer already holds sign-in
 * to the directory.
 */
export function allowedProfile(settings: Settings, profile: Record<string, unknown> | undefined) {
  if (!profile) return false;
  if (settings.identityProvider === 'google') {
    const domain = settings.oidcTenantId?.trim().toLowerCase();
    return Boolean(domain) && profile.hd === domain && profile.email_verified === true;
  }
  return true;
}
