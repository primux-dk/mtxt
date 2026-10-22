import 'server-only';
import { cache } from 'react';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import {
  backfillTitleKeys,
  bootstrapIdentity,
  cloudflareAdapters,
  DEFAULT_SETTINGS,
  ensureWebhookSecret,
  readSettings,
  refoldTemplateKeys,
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

/**
 * The webhook secret the speech-to-text provider sends back
 * (settings.webhook_secret) is made on the first request that finds none,
 * sealed. The transcribe job makes it too, if it gets there first.
 */
async function bootstrapWebhookSecret(settings: Settings): Promise<boolean> {
  if (settings.webhookSecret) return false;
  const env = await getEnv();
  const key = env.SETTINGS_KEY;
  if (!key) return false;
  const { db, installId } = await getAdapters();
  await ensureWebhookSecret(db, installId, (plain) => seal(plain, 'settings.webhook_secret', key));
  return true;
}

/**
 * Template keys from migration 0002 are folded on the first request a Worker
 * isolate serves (lib: refoldTemplateKeys, idempotent). Once per isolate, so
 * later requests pay nothing.
 */
let refolded: Promise<unknown> | null = null;
function refoldOnce(db: Parameters<typeof refoldTemplateKeys>[0], installId: string) {
  refolded ??= refoldTemplateKeys(db, installId).catch((error) => {
    refolded = null;
    console.warn('Could not refold template keys:', (error as Error).message);
  });
  return refolded;
}

/**
 * Meetings from before the capture migration get their search key
 * (meetings.title_folded) on the first request an isolate serves: SQLite
 * cannot fold æ, ø and å, so the app does (backfillTitleKeys, idempotent).
 */
let titlesFolded: Promise<unknown> | null = null;
function foldTitlesOnce(db: Parameters<typeof backfillTitleKeys>[0], installId: string) {
  titlesFolded ??= backfillTitleKeys(db, installId)
    .then((filled) => {
      if (filled) console.log(`Folded ${filled} meeting titles for search.`);
    })
    .catch((error) => {
      titlesFolded = null;
      console.warn('Could not fold meeting titles yet:', (error as Error).message);
    });
  return titlesFolded;
}

/** The install's settings row, read once per request. */
export const getInstallSettings = cache(async (): Promise<Settings> => {
  const { db, installId } = await getAdapters();
  try {
    const settings = await readSettings(db, installId);
    await Promise.all([refoldOnce(db, installId), foldTitlesOnce(db, installId)]);
    const changed = [await bootstrap(settings), await bootstrapWebhookSecret(settings)];
    return changed.some(Boolean) ? await readSettings(db, installId) : settings;
  } catch (error) {
    // Most likely a fresh checkout: the local database has no tables yet.
    const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error);
    console.warn(
      `Could not read the settings row (${reason}); using the defaults. Run \`pnpm db:migrate && pnpm db:seed\`.`,
    );
    return { installId, ...DEFAULT_SETTINGS };
  }
});
