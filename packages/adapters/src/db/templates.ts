import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from './index';
import { meetings, recaps, templates } from './schema';

export async function listTemplates(db: Db, installId: string) {
  return db
    .select()
    .from(templates)
    .where(eq(templates.installId, installId))
    .orderBy(asc(templates.name));
}

/**
 * Adds a template. The id comes from the caller, so a retry of the same add
 * is a no-op rather than a second row. The first template becomes the default.
 */
export async function createTemplate(
  db: Db,
  installId: string,
  value: { id: string; name: string; bodyMd: string },
) {
  const existing = await db
    .select({ id: templates.id })
    .from(templates)
    .where(eq(templates.installId, installId))
    .limit(1);
  await db
    .insert(templates)
    .values({ installId, ...value, isDefault: existing.length === 0 })
    .onConflictDoNothing({ target: templates.id });
}

export async function updateTemplate(
  db: Db,
  installId: string,
  id: string,
  value: { name: string; bodyMd: string },
) {
  const rows = await db
    .update(templates)
    .set(value)
    .where(and(eq(templates.installId, installId), eq(templates.id, id)))
    .returning({ id: templates.id });
  return rows.length > 0;
}

export async function setDefaultTemplate(db: Db, installId: string, id: string) {
  await db.batch([
    db
      .update(templates)
      .set({ isDefault: false })
      .where(and(eq(templates.installId, installId), ne(templates.id, id))),
    db
      .update(templates)
      .set({ isDefault: true })
      .where(and(eq(templates.installId, installId), eq(templates.id, id))),
  ]);
}

/**
 * Deletes a template. Meetings and recaps that used it keep their content and
 * lose only the link. Deleting a template that is gone already succeeds.
 */
export async function deleteTemplate(db: Db, installId: string, id: string) {
  await db.batch([
    db
      .update(meetings)
      .set({ templateId: null })
      .where(and(eq(meetings.installId, installId), eq(meetings.templateId, id))),
    db
      .update(recaps)
      .set({ templateId: null })
      .where(and(eq(recaps.installId, installId), eq(recaps.templateId, id))),
    db.delete(templates).where(and(eq(templates.installId, installId), eq(templates.id, id))),
  ]);
}
