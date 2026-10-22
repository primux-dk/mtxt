import 'server-only';
import { cache } from 'react';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cloudflareAdapters, DEFAULT_SETTINGS, readSettings, type Settings } from '@mtxt/adapters';

/** The adapters for this request. The app reaches Cloudflare only through these. */
export const getAdapters = cache(async () => {
  const { env } = await getCloudflareContext({ async: true });
  return cloudflareAdapters(env);
});

/** The install's settings row, read once per request. */
export const getInstallSettings = cache(async (): Promise<Settings> => {
  const { db, installId } = await getAdapters();
  try {
    return await readSettings(db, installId);
  } catch (error) {
    // Most likely a fresh checkout: the local database has no tables yet.
    const reason = error instanceof Error ? (error.cause ?? error).toString() : String(error);
    console.warn(
      `Could not read the settings row (${reason}); using the defaults. Run \`pnpm db:migrate && pnpm db:seed\`.`,
    );
    return { installId, ...DEFAULT_SETTINGS };
  }
});
