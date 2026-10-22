import { eq } from 'drizzle-orm';
import type { Db } from './index';
import { DEFAULT_SETTINGS } from './defaults';
import { settings, type Settings } from './schema';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The install's settings row, or the defaults when the row is not seeded yet.
 * Theme values that are not a plain #rrggbb fall back to the defaults, so a
 * bad row can never inject CSS.
 */
export async function readSettings(db: Db, installId: string): Promise<Settings> {
  const row = await db.query.settings.findFirst({ where: eq(settings.installId, installId) });
  const value: Settings = row ?? { installId, ...DEFAULT_SETTINGS };
  return {
    ...value,
    themeAccent: HEX.test(value.themeAccent) ? value.themeAccent : DEFAULT_SETTINGS.themeAccent,
    themePrimary: HEX.test(value.themePrimary) ? value.themePrimary : DEFAULT_SETTINGS.themePrimary,
  };
}
