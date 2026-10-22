import 'server-only';
import { cache } from 'react';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  bootstrapIdentity,
  cloudflareAdapters,
  DEFAULT_SETTINGS,
  readSettings,
  seal,
  type IdentityProvider,
  type Settings,
} from '@mtxt/adapters';
import { isTenantGuid } from './auth/identity';

/** The Worker's env for this request: bindings, vars and secrets. */
export const getEnv = cache(async () => (await getCloudflareContext({ async: true })).env);

/** The adapters for this request. The app reaches Cloudflare only through these. */
export const getAdapters = cache(async () => cloudflareAdapters(await getEnv()));

/** `OIDC_PROVIDER` as the deploy may write it, to the settings row's value. */
export function identityProviderFromEnv(value: string | undefined): IdentityProvider | null {
  const v = value?.trim().toLowerCase();
  if (v === 'entra' || v === 'microsoft-entra-id' || v === 'microsoft') return 'entra';
  if (v === 'google') return 'google';
  return null;
}

/**
 * A fresh install's company login comes from the deploy's Worker secrets: the
 * first request that finds no identity provider in the row writes them there,
 * the secret sealed. After that the settings page is the source.
 */
async function bootstrap(settings: Settings): Promise<boolean> {
  if (settings.identityProvider) return false;
  const env = await getEnv();
  const provider = identityProviderFromEnv(env.OIDC_PROVIDER);
  const tenant = env.OIDC_TENANT_ID?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const secret = env.OIDC_CLIENT_SECRET?.trim();
  if (!provider || !tenant || !clientId || !secret || !env.SETTINGS_KEY) return false;
  // An Entra tenant is pinned by its GUID; `common` and the like are refused.
  if (provider === 'entra' && !isTenantGuid(tenant)) return false;
  const { db, installId } = await getAdapters();
  await bootstrapIdentity(db, installId, {
    identityProvider: provider,
    oidcTenantId: tenant,
    oidcClientId: clientId,
    oidcClientSecret: await seal(secret, 'settings.oidc_client_secret', env.SETTINGS_KEY),
  });
  return true;
}

/** The install's settings row, read once per request. */
export const getInstallSettings = cache(async (): Promise<Settings> => {
  const { db, installId } = await getAdapters();
  try {
    const settings = await readSettings(db, installId);
    return (await bootstrap(settings)) ? await readSettings(db, installId) : settings;
  } catch (error) {
    // Most likely a fresh checkout: the local database has no tables yet.
    const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error);
    console.warn(
      `Could not read the settings row (${reason}); using the defaults. Run \`pnpm db:migrate && pnpm db:seed\`.`,
    );
    return { installId, ...DEFAULT_SETTINGS };
  }
});
