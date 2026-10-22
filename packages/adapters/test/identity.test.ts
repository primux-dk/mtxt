import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import * as schema from '../src/db/schema';
import { seedSql } from '../src/db/seed';
import { readSettings, saveSettings } from '../src/db/settings';
import { createTemplate, templateNameKey } from '../src/db/templates';
import { AccountConflictError, recordSignIn } from '../src/db/users';

const migrationsDir = new URL('../migrations/', import.meta.url);

/** An in-memory SQLite with every migration, behind Drizzle the way D1 is. */
async function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
  sqlite.exec(seedSql('t'));
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
  const db = drizzle(
    async (query, params, method) => run(query, params, method),
    async (queries) => queries.map((q) => run(q.sql, q.params, q.method)),
    { schema },
  ) as unknown as Db;
  return { db, sqlite };
}

describe('sign-in identity', () => {
  let db: Db;
  let sqlite: DatabaseSync;
  beforeEach(async () => ({ db, sqlite } = await database()));

  const count = (table: string) =>
    (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('makes the first user admin, once', async () => {
    const first = await recordSignIn(db, 't', {
      subject: 's1',
      email: 'Mette@Example.com',
      name: 'Mette',
    });
    expect(first.isAdmin).toBe(true);
    expect((await readSettings(db, 't')).adminEmails).toEqual(['mette@example.com']);
    const second = await recordSignIn(db, 't', {
      subject: 's2',
      email: 'anne@example.com',
      name: 'Anne',
    });
    expect(second.isAdmin).toBe(false);
  });

  it('never claims again, however empty the list becomes', async () => {
    await recordSignIn(db, 't', { subject: 's1', email: 'mette@example.com', name: 'Mette' });
    sqlite.exec(`UPDATE settings SET admin_emails = '[]'`);
    const next = await recordSignIn(db, 't', {
      subject: 's2',
      email: 'anne@example.com',
      name: 'Anne',
    });
    expect(next.isAdmin).toBe(false);
    expect((await readSettings(db, 't')).adminEmails).toEqual([]);
  });

  it('ends the bootstrap when the list is first saved', async () => {
    await saveSettings(db, 't', { productName: 'Meetings', adminEmails: ['ops@example.com'] });
    const user = await recordSignIn(db, 't', {
      subject: 's1',
      email: 'anne@example.com',
      name: 'Anne',
    });
    expect(user.isAdmin).toBe(false);
    expect((await readSettings(db, 't')).adminEmails).toEqual(['ops@example.com']);
  });

  it('refuses a second subject with an admin address and writes nothing', async () => {
    await recordSignIn(db, 't', { subject: 's1', email: 'mette@example.com', name: 'Mette' });
    const before = sqlite.prepare('SELECT * FROM users').all();
    const settingsBefore = sqlite.prepare('SELECT * FROM settings').all();
    await expect(
      recordSignIn(db, 't', { subject: 'other', email: 'METTE@example.com', name: 'Impostor' }),
    ).rejects.toBeInstanceOf(AccountConflictError);
    expect(sqlite.prepare('SELECT * FROM users').all()).toEqual(before);
    expect(sqlite.prepare('SELECT * FROM settings').all()).toEqual(settingsBefore);
    expect(count('users')).toBe(1);
  });

  it('lets the same subject sign in again and refreshes its name', async () => {
    await recordSignIn(db, 't', { subject: 's1', email: 'mette@example.com', name: 'Mette' });
    const again = await recordSignIn(db, 't', {
      subject: 's1',
      email: 'mette@example.com',
      name: 'Mette Lund',
    });
    expect(again).toMatchObject({ name: 'Mette Lund', isAdmin: true });
    expect(count('users')).toBe(1);
  });

  it('holds one address to one user row in the database too', () => {
    sqlite.exec(
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('a', 't', 's1', 'x@example.com', 'X')`,
    );
    expect(() =>
      sqlite.exec(
        `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('b', 't', 's2', 'x@example.com', 'X')`,
      ),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('template names', () => {
  it('fold case, width and surrounding space into one key', () => {
    expect(templateNameKey('  Produktionsmøde ')).toBe(templateNameKey('PRODUKTIONSMØDE'));
    expect(templateNameKey('Straße')).toBe(templateNameKey('STRASSE'));
    expect(templateNameKey('ＡＢＣ')).toBe('abc');
  });

  it('cannot hold two names with the same key', async () => {
    const { db } = await database();
    await createTemplate(db, 't', {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Møde',
      bodyMd: '',
    });
    await expect(
      createTemplate(db, 't', {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'MØDE',
        bodyMd: '',
      }),
    ).rejects.toThrow();
  });
});
