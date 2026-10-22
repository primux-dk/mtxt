import { and, eq, isNull } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { foldTitle } from './fold';
import * as schema from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = BaseSQLiteDatabase<'async', any, typeof schema>;

/**
 * Fills meetings.title_folded for rows that have none: rows from before
 * migration 0001, whose titles SQLite cannot fold (it lower-cases ASCII
 * only). Uses the same foldTitle as create and rename. Idempotent: a row
 * with a key is never touched, so it can run on every start-up.
 * Returns the number of rows it filled.
 */
export async function backfillTitleKeys(
  db: AnyDb,
  installId: string,
  batch = 200,
): Promise<number> {
  const m = schema.meetings;
  let filled = 0;
  for (;;) {
    const rows = await db
      .select({ id: m.id, title: m.title })
      .from(m)
      .where(and(eq(m.installId, installId), isNull(m.titleFolded)))
      .limit(batch);
    if (!rows.length) return filled;
    for (const row of rows) {
      await db
        .update(m)
        .set({ titleFolded: foldTitle(row.title) })
        .where(and(eq(m.id, row.id), eq(m.installId, installId), isNull(m.titleFolded)));
    }
    filled += rows.length;
    if (rows.length < batch) return filled;
  }
}
