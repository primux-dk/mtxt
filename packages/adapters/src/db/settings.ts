import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './index';
import { DEFAULT_SETTINGS } from './defaults';
import { keyterms, settings, users, type NewSettings, type Settings } from './schema';

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
    adminEmails: Array.isArray(value.adminEmails) ? value.adminEmails : [],
    recordingSources: Array.isArray(value.recordingSources) ? value.recordingSources : [],
  };
}

export interface IdentityBootstrap {
  identityProvider: NonNullable<Settings['identityProvider']>;
  oidcTenantId: string;
  oidcClientId: string;
  /** Already sealed. */
  oidcClientSecret: string;
}

/**
 * Writes the deploy's initial OIDC values into the settings row, once: only
 * while the row has no identity provider. After that the settings page is the
 * source. One statement, so two first requests cannot both write.
 */
export async function bootstrapIdentity(db: Db, installId: string, values: IdentityBootstrap) {
  await db
    .insert(settings)
    .values({ installId, ...DEFAULT_SETTINGS, adminEmails: [], ...values })
    .onConflictDoUpdate({
      target: settings.installId,
      set: values,
      where: isNull(settings.identityProvider),
    });
}

/**
 * Saves the settings page: the row, the keyterm list and the admin flag on
 * every user, in one batch. `patch` holds only the columns the page changed;
 * a secret left blank on the page is not in it.
 */
export async function saveSettings(
  db: Db,
  installId: string,
  patch: Omit<Partial<NewSettings>, 'installId'> & Pick<NewSettings, 'productName'>,
  terms?: readonly { term: string; boost: number | null }[],
) {
  const upsert = db
    .insert(settings)
    .values({ installId, ...DEFAULT_SETTINGS, adminEmails: [], ...patch })
    .onConflictDoUpdate({ target: settings.installId, set: patch });
  const extra = [];
  if (terms) {
    extra.push(db.delete(keyterms).where(eq(keyterms.installId, installId)));
    // D1 caps bound parameters per statement, so long lists go in slices.
    for (let i = 0; i < terms.length; i += 20) {
      extra.push(
        db
          .insert(keyterms)
          .values(terms.slice(i, i + 20).map((t) => ({ installId, term: t.term, boost: t.boost }))),
      );
    }
  }
  if (patch.adminEmails) {
    extra.push(
      db
        .update(users)
        .set({
          isAdmin: sql`lower(${users.email}) IN (SELECT value FROM json_each(${JSON.stringify(patch.adminEmails)}))`,
        })
        .where(eq(users.installId, installId)),
    );
  }
  await db.batch([upsert, ...extra]);
}

/** The install's keyterm list, in the order it was saved. */
export async function listKeyterms(db: Db, installId: string) {
  return db
    .select({ term: keyterms.term, boost: keyterms.boost })
    .from(keyterms)
    .where(eq(keyterms.installId, installId))
    .orderBy(sql`rowid`);
}

/**
 * Makes `email` the first admin when the install has none yet. Returns true
 * when this call claimed it. The condition is in the statement, so two first
 * sign-ins cannot both win.
 */
export async function claimFirstAdmin(db: Db, installId: string, email: string) {
  await db
    .insert(settings)
    .values({ installId, ...DEFAULT_SETTINGS, adminEmails: [] })
    .onConflictDoNothing();
  const claimed = await db
    .update(settings)
    .set({ adminEmails: [email] })
    .where(and(eq(settings.installId, installId), sql`${settings.adminEmails} = '[]'`))
    .returning({ installId: settings.installId });
  return claimed.length > 0;
}
