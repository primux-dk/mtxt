/**
 * An in-memory SQLite with every migration applied, behind Drizzle the async
 * way D1 runs it, batches included. For tests of code that writes rows.
 */
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { schema, type Db } from '@mtxt/adapters';

const migrationsDir = new URL('../../../packages/adapters/migrations/', import.meta.url);

export async function testDb(): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) raw.exec(await readFile(new URL(file, migrationsDir), 'utf8'));

  const run = (query: string, params: unknown[], method: string) => {
    const statement = raw.prepare(query);
    if (method === 'run') {
      statement.run(...(params as never[]));
      return { rows: [] as unknown[] };
    }
    statement.setReturnArrays(true);
    const rows = statement.all(...(params as never[])) as unknown as unknown[][];
    return { rows: method === 'get' ? rows[0] : rows } as { rows: unknown[] };
  };
  const db = drizzle(
    async (query, params, method) => run(query, params, method),
    async (queries) => {
      raw.exec('BEGIN');
      try {
        const out = queries.map((q) => run(q.sql, q.params, q.method));
        raw.exec('COMMIT');
        return out;
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
    { schema },
  );
  return { db: db as unknown as Db, raw };
}

export const INSTALL = 'test-install';

/** A user, a meeting and a confirmed recording, ready to transcribe. */
export function seedRecording(raw: DatabaseSync, id = 'rec-1', meetingId = 'meet-1') {
  raw.exec(`INSERT OR IGNORE INTO users (id, install_id, oidc_subject, email, name) VALUES
      ('owner', '${INSTALL}', 'sub', 'owner@example.com', 'Mette Lund');
    INSERT OR IGNORE INTO meetings (id, install_id, owner_id, title, started_at, visibility)
      VALUES ('${meetingId}', '${INSTALL}', 'owner', 'Møde', 0, 'private');
    INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s, sha256,
      size_bytes, content_type, storage_path, status, created_at, confirmed_at)
      VALUES ('${id}', '${INSTALL}', '${meetingId}', 'owner', 'upload', 72, '${'0'.repeat(64)}',
      1000, 'audio/webm', 'recordings/x/${id}.webm', 'transcribing', 1, 1);`);
}
