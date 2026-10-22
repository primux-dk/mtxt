import 'server-only';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { open, type IdentityProvider, type Settings } from '@mtxt/adapters';
import { identityProviderFromEnv } from '../install';
import { isTenantGuid } from './identity';

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
  /** Names of the Worker secrets a fresh install still lacks or has wrong. */
  | { kind: 'missing'; names: string[]; tenantNotGuid: boolean }
  /** The stored client secret cannot be opened with this SETTINGS_KEY. */
  | { kind: 'broken' };

/** What the login page can offer, from the settings row and the Worker's secrets. */
export async function loginSetup(settings: Settings, env: CloudflareEnv): Promise<LoginSetup> {
  const names: string[] = [];
  let tenantNotGuid = false;
  if (!env.AUTH_SECRET) names.push('AUTH_SECRET');
  if (!env.SETTINGS_KEY) names.push('SETTINGS_KEY');
  if (!settings.identityProvider || !settings.oidcClientId || !settings.oidcClientSecret) {
    const oidc = [
      'OIDC_PROVIDER',
      'OIDC_TENANT_ID',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
    ] as const;
    const unset: string[] = oidc.filter((name) => !env[name]?.trim());
    // An Entra tenant must be pinned by its GUID.
    tenantNotGuid =
      identityProviderFromEnv(env.OIDC_PROVIDER) === 'entra' &&
      Boolean(env.OIDC_TENANT_ID?.trim()) &&
      !isTenantGuid(env.OIDC_TENANT_ID);
    if (tenantNotGuid) unset.push('OIDC_TENANT_ID');
    // Every value is there, but the provider name is not one we know.
    if (unset.length === 0 && env.SETTINGS_KEY && !identityProviderFromEnv(env.OIDC_PROVIDER)) {
      unset.push('OIDC_PROVIDER');
    }
    names.push(...unset);
  }
  if (names.length) return { kind: 'missing', names, tenantNotGuid };
  return (await clientSecret(settings, env)) === null
    ? { kind: 'broken' }
    : { kind: 'ready', provider: settings.identityProvider! };
}

async function clientSecret(settings: Settings, env: CloudflareEnv): Promise<string | null> {
  if (!settings.oidcClientSecret || !env.SETTINGS_KEY) return null;
  try {
    return await open(settings.oidcClientSecret, 'settings.oidc_client_secret', env.SETTINGS_KEY);
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
    if (!isTenantGuid(tenant)) return null;
    return MicrosoftEntraID({
      clientId,
      clientSecret: secret,
      // Pinned to the tenant's GUID; the sign-in callback also checks `tid`.
      issuer: `https://login.microsoftonline.com/${tenant.toLowerCase()}/v2.0`,
      // No Graph photo: the default profile fetches one into the session cookie.
      authorization: { params: { scope: 'openid profile email' } },
      profile: (p) => ({
        id: p.sub,
        name: p.name ?? null,
        // The sign-in callbacks pick the address from the raw claims (lib/auth/identity.ts).
        email: (p as { preferred_username?: string }).preferred_username ?? p.email ?? null,
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
