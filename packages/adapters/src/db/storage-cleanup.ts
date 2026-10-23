import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { deleteStored, type StorageAdapter } from '../storage';
import type { Db } from './index';
import { storageCleanup } from './schema';

/** A storage object to delete once its rows are gone. */
export interface CleanupEntry {
  id: string;
  path: string;
}

/** Retries per object before the nightly job stops and says so. */
export const CLEANUP_MAX_ATTEMPTS = 10;
const PAGE = 100;

/** Entries for paths, with their ids made here, so the caller knows them after the batch. */
export const cleanupEntries = (paths: readonly string[]): CleanupEntry[] =>
  [...new Set(paths.filter(Boolean))].map((path) => ({ id: crypto.randomUUID(), path }));

/**
 * The insert that records the paths, for the same D1 batch that removes
 * their rows: the record and the removal land together or not at all.
 * Null when there is nothing to record.
 */
export function recordCleanup(db: Db, installId: string, entries: readonly CleanupEntry[]) {
  if (!entries.length) return null;
  return db.insert(storageCleanup).values(entries.map((e) => ({ ...e, installId })));
}

/**
 * Deletes the objects of entries whose rows are committed gone, one by one,
 * and each entry with its object. An object storage refuses keeps its entry,
 * one attempt more, for the nightly job. Never throws: the delete that
 * called it has already happened.
 */
export async function finishCleanup(
  db: Db,
  storage: Pick<StorageAdapter, 'delete'> & Partial<Pick<StorageAdapter, 'list'>>,
  installId: string,
  entries: readonly CleanupEntry[],
  log: Pick<Console, 'error'> = console,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      // A path ending in "/" is a prefix: a transcript's pieces (packet 17).
      await deleteStored(storage, entry.path);
      await db
        .delete(storageCleanup)
        .where(and(eq(storageCleanup.installId, installId), eq(storageCleanup.id, entry.id)));
      deleted++;
    } catch (error) {
      failed++;
      log.error(`Storage cleanup failed for ${entry.path}; kept for the nightly retry`, error);
      await db
        .update(storageCleanup)
        .set({ attempts: sql`${storageCleanup.attempts} + 1` })
        .where(and(eq(storageCleanup.installId, installId), eq(storageCleanup.id, entry.id)))
        .catch(() => {});
    }
  }
  return { deleted, failed };
}

/**
 * The nightly retry: every entry under CLEANUP_MAX_ATTEMPTS, oldest first,
 * page by page. An entry that reaches the limit stays in the table and is
 * logged as given up, for a person to look at.
 */
export async function retryStorageCleanup(
  db: Db,
  storage: Pick<StorageAdapter, 'delete'> & Partial<Pick<StorageAdapter, 'list'>>,
  installId: string,
  log: Pick<Console, 'error'> = console,
): Promise<{ deleted: number; failed: number; givenUp: number }> {
  const total = { deleted: 0, failed: 0, givenUp: 0 };
  const c = storageCleanup;
  // Keyset pages, so each entry is tried once a night.
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const page: { id: string; path: string; createdAt: Date }[] = await db
      .select({ id: c.id, path: c.path, createdAt: c.createdAt })
      .from(c)
      .where(
        and(
          eq(c.installId, installId),
          lt(c.attempts, CLEANUP_MAX_ATTEMPTS),
          after
            ? sql`(${c.createdAt}, ${c.id}) > (${after.createdAt.getTime()}, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(c.createdAt), asc(c.id))
      .limit(PAGE);
    if (!page.length) break;
    const result = await finishCleanup(db, storage, installId, page, log);
    total.deleted += result.deleted;
    total.failed += result.failed;
    if (page.length < PAGE) break;
    after = page.at(-1)!;
  }
  const stuck = await db
    .select({ path: c.path })
    .from(c)
    .where(and(eq(c.installId, installId), gte(c.attempts, CLEANUP_MAX_ATTEMPTS)));
  for (const s of stuck) {
    log.error(`Storage cleanup gave up on ${s.path} after ${CLEANUP_MAX_ATTEMPTS} attempts`);
  }
  total.givenUp = stuck.length;
  return total;
}
