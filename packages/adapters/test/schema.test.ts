import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { beforeEach, describe, expect, it } from 'vitest';
import * as contract from '@mtxt/contract';
import { DEFAULT_SETTINGS } from '../src/db/defaults';
import * as schema from '../src/db/schema';
import { seedSql } from '../src/db/seed';

const migrationsDir = new URL('../migrations/', import.meta.url);

/** An in-memory SQLite with every migration applied, the way wrangler applies them to D1. */
async function migratedDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
  return db;
}

const tables: SQLiteTable[] = Object.values(schema).filter(
  (value): value is never => value instanceof SQLiteTable,
);

describe('schema', () => {
  let db: DatabaseSync;
  beforeEach(async () => {
    db = await migratedDatabase();
  });

  it('defines every table from the spec data model', () => {
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([
      'audit_events',
      'decisions',
      'keyterms',
      'meeting_shares',
      'meetings',
      'recap_versions',
      'recaps',
      'recordings',
      'segments',
      'settings',
      'speakers',
      'templates',
      'transcripts',
      'users',
    ]);
  });

  it('puts install_id on every table', () => {
    for (const table of tables) {
      const columns = getTableConfig(table).columns.map((c) => c.name);
      expect(columns, getTableConfig(table).name).toContain('install_id');
    }
  });

  it('has migrations that create exactly the schema columns', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const rows = db.prepare(`PRAGMA table_info(${config.name})`).all() as { name: string }[];
      expect(rows.map((r) => r.name).sort(), config.name).toEqual(
        config.columns.map((c) => c.name).sort(),
      );
    }
  });

  it('matches the contract status and source enums', () => {
    expect([...schema.RECORDING_STATUSES]).toEqual([...contract.RECORDING_STATUSES]);
    expect([...schema.RECORDING_SOURCES]).toEqual([...contract.RECORDING_SOURCES]);
  });

  it('seeds the default settings row once and reads it back through Drizzle', async () => {
    db.exec(seedSql('test'));
    db.exec(seedSql('test'));
    const orm = drizzle(
      async (query, params, method) => {
        const statement = db.prepare(query);
        if (method === 'run') {
          statement.run(...(params as never[]));
          return { rows: [] };
        }
        statement.setReturnArrays(true);
        const rows = statement.all(...(params as never[])) as unknown as unknown[][];
        return { rows: method === 'get' ? (rows[0] ?? []) : rows } as { rows: unknown[] };
      },
      { schema },
    );
    const rows = await orm
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.installId, 'test'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ installId: 'test', ...DEFAULT_SETTINGS });
  });

  it('refuses an install id that could break the seed SQL', () => {
    expect(() => seedSql("x'); DROP TABLE settings; --")).toThrow();
  });

  it('stamps created_at as integer milliseconds', () => {
    db.exec(
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 'test', 's', 'a@example.com', 'A')`,
    );
    db.exec(
      `INSERT INTO audit_events (id, install_id, user_id, action) VALUES ('e1', 'test', 'u1', 'opened')`,
    );
    const { at, kind } = db
      .prepare(`SELECT at, typeof(at) AS kind FROM audit_events WHERE id = 'e1'`)
      .get() as { at: number; kind: string };
    expect(kind).toBe('integer');
    expect(Math.abs(Number(at) - Date.now())).toBeLessThan(60_000);
  });
});
