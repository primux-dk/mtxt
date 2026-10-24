import { describe, expect, it, vi } from 'vitest';
import { retentionBatch } from '../src/db/retention';
import {
  CLEANUP_MAX_ATTEMPTS,
  cleanupEntries,
  finishCleanup,
  recordCleanup,
  retryStorageCleanup,
} from '../src/db/storage-cleanup';
import { syncSearch } from '../src/db/search';
import { DAY, fixtures, INSTALL, rows, testDb } from './sqlite';

const quiet = { error: vi.fn() };
const entries = (sqlite: Parameters<typeof rows>[0]) =>
  rows<{ path: string; attempts: number }>(
    sqlite,
    'select path, attempts from storage_cleanup order by path',
  );

describe('storage cleanup', () => {
  it('deletes each object, then its entry; keeps what storage refuses, one attempt more', async () => {
    const { db, sqlite } = testDb();
    const list = cleanupEntries(['a.webm', 'b.webm', '', 'a.webm']);
    expect(list.map((e) => e.path)).toEqual(['a.webm', 'b.webm']);
    await db.batch([recordCleanup(db, INSTALL, list)!]);
    const storage = {
      delete: async (key: string | string[]) => {
        if (key === 'b.webm') throw new Error('R2 down');
      },
    };
    expect(await finishCleanup(db, storage, INSTALL, list, quiet)).toEqual({
      deleted: 1,
      failed: 1,
    });
    expect(entries(sqlite)).toEqual([{ path: 'b.webm', attempts: 1 }]);
  });

  it('deletes a prefix page by page: a transcript sent in pieces (packet 18)', async () => {
    const { db, sqlite } = testDb();
    const keys = new Set([
      'transcripts/t/r/w-1/plan.json',
      ...Array.from({ length: 5 }, (_, i) => `transcripts/t/r/w-1/piece-00${i}.json`),
      'transcripts/t/r/w-2/plan.json',
      'transcripts/t/r/assemblyai-x.json',
    ]);
    const storage = {
      delete: async (key: string | string[]) => {
        for (const k of [key].flat()) keys.delete(k);
      },
      // Two keys a page, so the cursor is followed.
      list: async (prefix: string, options?: { cursor?: string }) => {
        const all = [...keys].filter((k) => k.startsWith(prefix)).sort();
        const from = Number(options?.cursor ?? 0);
        return {
          keys: all.slice(from, from + 2),
          ...(from + 2 < all.length ? { cursor: String(from + 2) } : {}),
        };
      },
    };
    const list = cleanupEntries(['transcripts/t/r/w-1/', 'transcripts/t/r/assemblyai-x.json']);
    await db.batch([recordCleanup(db, INSTALL, list)!]);
    expect(await finishCleanup(db, storage, INSTALL, list, quiet)).toEqual({
      deleted: 2,
      failed: 0,
    });
    expect([...keys]).toEqual(['transcripts/t/r/w-2/plan.json']);
    expect(entries(sqlite)).toEqual([]);
    // A store that cannot list keeps the entry for a person to look at.
    const blind = cleanupEntries(['transcripts/t/r/w-2/']);
    await db.batch([recordCleanup(db, INSTALL, blind)!]);
    expect(await finishCleanup(db, { delete: async () => {} }, INSTALL, blind, quiet)).toEqual({
      deleted: 0,
      failed: 1,
    });
  });

  it('retries nightly up to the limit, then says it gave up', async () => {
    const { db, sqlite } = testDb();
    await db.batch([recordCleanup(db, INSTALL, cleanupEntries(['stuck.webm', 'fine.webm']))!]);
    let up = false;
    const storage = {
      delete: async (key: string | string[]) => {
        if (key === 'stuck.webm' || !up) throw new Error('R2 down');
      },
    };
    await retryStorageCleanup(db, storage, INSTALL, quiet);
    up = true;
    await retryStorageCleanup(db, storage, INSTALL, quiet);
    expect(entries(sqlite)).toEqual([{ path: 'stuck.webm', attempts: 2 }]);
    for (let i = 0; i < CLEANUP_MAX_ATTEMPTS + 3; i++) {
      await retryStorageCleanup(db, storage, INSTALL, quiet);
    }
    expect(entries(sqlite)).toEqual([{ path: 'stuck.webm', attempts: CLEANUP_MAX_ATTEMPTS }]);
    const last = await retryStorageCleanup(db, storage, INSTALL, quiet);
    expect(last).toEqual({ deleted: 0, failed: 0, givenUp: 1 });
    expect(quiet.error).toHaveBeenCalledWith(
      `Storage cleanup gave up on stuck.webm after ${CLEANUP_MAX_ATTEMPTS} attempts`,
    );
  });

  it('pages through more entries than one page, each tried once a night', async () => {
    const { db, sqlite } = testDb();
    const list = cleanupEntries(Array.from({ length: 250 }, (_, i) => `x${i}.webm`));
    for (let i = 0; i < list.length; i += 50) {
      await db.batch([recordCleanup(db, INSTALL, list.slice(i, i + 50))!]);
    }
    const calls: string[] = [];
    const storage = { delete: async (key: string | string[]) => void calls.push(String(key)) };
    expect(await retryStorageCleanup(db, storage, INSTALL, quiet)).toEqual({
      deleted: 250,
      failed: 0,
      givenUp: 0,
    });
    expect(new Set(calls).size).toBe(250);
    expect(entries(sqlite)).toEqual([]);
  });

  it('retention records a docx it could not delete for the nightly retry, and none for a kept meeting', async () => {
    const { db, sqlite } = testDb();
    const f = fixtures(sqlite);
    f.user('owner');
    const now = new Date(Date.UTC(2026, 9, 22, 3));
    for (const id of ['gone', 'kept']) {
      f.meeting(id, { owner: 'owner', startedAt: now.getTime() - 400 * DAY });
      f.recap(`${id}-c`, id, '# Referat', `exports/${id}.docx`);
      await syncSearch(db, INSTALL, {
        meetingId: id,
        recap: { id: `${id}-c`, bodyMd: '# Referat' },
      });
    }
    const storage = {
      delete: async (key: string | string[]) => {
        if (key === 'exports/gone.docx') {
          // The owner presses Keep on the other meeting while storage is busy.
          sqlite.exec("UPDATE meetings SET keep = 1 WHERE id = 'kept'");
          throw new Error('R2 down');
        }
      },
    };
    const settings = { retentionAudioDays: 30, retentionTranscriptDays: 365 };
    await retentionBatch({ db, storage, installId: INSTALL }, settings, now);
    expect(entries(sqlite)).toEqual([{ path: 'exports/gone.docx', attempts: 1 }]);
    expect(rows(sqlite, "select id from recaps where meeting_id = 'kept'")).toHaveLength(1);
  });
});
