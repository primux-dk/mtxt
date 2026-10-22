import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import * as schema from '../src/db/schema';
import { refoldTemplateKeys, templateNameKey } from '../src/db/templates';

const migrationsDir = new URL('../migrations/', import.meta.url);
const files = async () => (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const apply = async (sqlite: DatabaseSync, file: string) =>
  sqlite.exec(await readFile(new URL(file, migrationsDir), 'utf8'));

/** A database at 0001 (before 0002), the shape packet 2's first review round shipped. */
async function at0001() {
  const sqlite = new DatabaseSync(':memory:');
  const all = await files();
  for (const file of all.filter((f) => f < '0002')) await apply(sqlite, file);
  return { sqlite, rest: all.filter((f) => f >= '0002') };
}

const orm = (sqlite: DatabaseSync) => {
  const run = (query: string, params: unknown[], method: string) => {
    const statement = sqlite.prepare(query);
    if (method === 'run') {
      statement.run(...(params as never[]));
      return { rows: [] };
    }
    statement.setReturnArrays(true);
    const rows = statement.all(...(params as never[])) as unknown as unknown[][];
    return { rows: method === 'get' ? (rows[0] ?? []) : rows } as { rows: unknown[] };
  };
  return drizzle(
    async (q, p, m) => run(q, p, m),
    async (queries) => queries.map((q) => run(q.sql, q.params, q.method)),
    { schema },
  ) as unknown as Db;
};

const settingsRow = (adminEmails: string) =>
  `INSERT INTO settings (install_id, product_name, admin_emails) VALUES ('t', 'Meetings', '${adminEmails}')`;

describe('migration 0002 on a 0001 database', () => {
  it('marks the admin claim done when the install has a user, even with an empty list', async () => {
    const { sqlite, rest } = await at0001();
    sqlite.exec(settingsRow('[]'));
    sqlite.exec(
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 't', 's1', 'a@example.com', 'A')`,
    );
    for (const file of rest) await apply(sqlite, file);
    const row = sqlite.prepare('SELECT admin_bootstrap_claimed_at AS at FROM settings').get() as {
      at: number | null;
    };
    expect(row.at).toBeTypeOf('number');
  });

  it('leaves the claim open on an install with no user and no admin', async () => {
    const { sqlite, rest } = await at0001();
    sqlite.exec(settingsRow('[]'));
    for (const file of rest) await apply(sqlite, file);
    const row = sqlite.prepare('SELECT admin_bootstrap_claimed_at AS at FROM settings').get() as {
      at: number | null;
    };
    expect(row.at).toBeNull();
  });

  it('creates the name-key index over colliding names, keeps the ids, and the refold makes keys consistent', async () => {
    const { sqlite, rest } = await at0001();
    const insert = (id: string, name: string) =>
      sqlite.exec(
        `INSERT INTO templates (id, install_id, name, body_md) VALUES ('${id}', 't', '${name}', '')`,
      );
    insert('a1', 'Review');
    insert('a2', 'REVIEW');
    insert('b1', 'Straße');
    insert('b2', 'STRASSE');
    for (const file of rest) await apply(sqlite, file);

    const keys = () =>
      sqlite.prepare('SELECT id, name, name_key AS key FROM templates ORDER BY rowid').all() as {
        id: string;
        name: string;
        key: string;
      }[];
    // After the migration: the index exists and the later Review got its id appended.
    expect(
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'templates_install_name_key'`)
        .get(),
    ).toBeDefined();
    expect(keys().map((r) => r.key)).toEqual(['review', 'review-a2', 'straße', 'strasse']);

    const db = orm(sqlite);
    expect(await refoldTemplateKeys(db, 't')).toBe(3);
    expect(keys()).toEqual([
      { id: 'a1', name: 'Review', key: 'review' },
      { id: 'a2', name: 'REVIEW (2)', key: 'review (2)' },
      { id: 'b1', name: 'Straße', key: 'strasse' },
      { id: 'b2', name: 'STRASSE (2)', key: 'strasse (2)' },
    ]);
    for (const row of keys()) expect(row.key).toBe(templateNameKey(row.name));
    // Idempotent.
    expect(await refoldTemplateKeys(db, 't')).toBe(0);
  });
});
