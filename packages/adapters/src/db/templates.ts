import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './index';
import { meetings, recaps, templates } from './schema';

/**
 * The key two template names collide on: trimmed, Unicode-normalised and
 * case-folded. JavaScript has no full case fold, so lower-casing covers it
 * after the two folds that lower-casing misses (ß to ss, final sigma).
 */
export function templateNameKey(name: string): string {
  return name
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('ς', 'σ')
    .normalize('NFKC');
}

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
    .values({
      installId,
      ...value,
      nameKey: templateNameKey(value.name),
      isDefault: existing.length === 0,
    })
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
    .set({ ...value, nameKey: templateNameKey(value.name) })
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

/**
 * Brings every stored `name_key` to `templateNameKey(name)`. Migration 0002
 * could only lower-case ASCII, so a key may be short of the full fold or carry
 * the id it got to dodge a collision. When two names fold to one key, the
 * later template (by rowid) is renamed "<name> (2)", or the next free number.
 * Idempotent: with every key current it reads and writes nothing more.
 */
export async function refoldTemplateKeys(db: Db, installId: string) {
  const rows = await db
    .select({ id: templates.id, name: templates.name, nameKey: templates.nameKey })
    .from(templates)
    .where(eq(templates.installId, installId))
    .orderBy(sql`rowid`);
  const used = new Set<string>();
  const changes: { id: string; name: string; nameKey: string }[] = [];
  for (const row of rows) {
    let name = row.name;
    let key = templateNameKey(name);
    for (let n = 2; used.has(key); n++) {
      name = `${row.name} (${n})`;
      key = templateNameKey(name);
    }
    used.add(key);
    if (key !== row.nameKey || name !== row.name) changes.push({ id: row.id, name, nameKey: key });
  }
  if (changes.length === 0) return 0;
  const where = (id: string) => and(eq(templates.installId, installId), eq(templates.id, id));
  // Two passes in one batch, so a key moving onto another row's old key never trips the index.
  const [first, ...rest] = [
    ...changes.map((c) =>
      db
        .update(templates)
        .set({ nameKey: `~refold~${c.id}` })
        .where(where(c.id)),
    ),
    ...changes.map((c) =>
      db.update(templates).set({ name: c.name, nameKey: c.nameKey }).where(where(c.id)),
    ),
  ];
  await db.batch([first!, ...rest]);
  return changes.length;
}
