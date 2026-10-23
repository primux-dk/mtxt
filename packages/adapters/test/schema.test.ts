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

/** Drizzle on node:sqlite, the async way D1 runs it. */
function proxy(db: DatabaseSync) {
  return drizzle(
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
      'recap_images',
      'recap_jobs_seen',
      'recap_outbox',
      'recap_versions',
      'recaps',
      'recorder_grants',
      'recorder_tokens',
      'recordings',
      'segments',
      'settings',
      'speakers',
      'storage_cleanup',
      'templates',
      'transcripts',
      'users',
      'webhook_deliveries',
      'webhook_endpoints',
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
    const orm = proxy(db);
    const rows = await orm
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.installId, 'test'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ installId: 'test', ...DEFAULT_SETTINGS });
  });

  it("seeds a deploy's values into a new row and never over an existing one", async () => {
    const values = {
      productName: "Acme's Møder",
      companyName: 'Acme A/S',
      language: 'da',
      interfaceLanguage: 'da',
      aiGatewayId: 'mtxt-gateway',
    } as const;
    db.exec(seedSql('deploy', values));
    db.exec(seedSql('deploy', { productName: 'Something else' }));
    const orm = proxy(db);
    const rows = await orm
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.installId, 'deploy'));
    expect(rows).toEqual([{ installId: 'deploy', ...DEFAULT_SETTINGS, ...values }]);
  });

  it('indexes every foreign key by the referencing column first', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const leading = new Set<string>(
        config.indexes.map((i) => (i.config.columns[0] as { name: string }).name),
      );
      for (const pk of config.primaryKeys) leading.add(pk.columns[0]!.name);
      for (const fk of config.foreignKeys) {
        const column = fk.reference().columns[0]!.name;
        expect(leading, `${config.name}.${column}`).toContain(column);
      }
    }
  });

  describe('constraints', () => {
    const insertUserAndMeeting = () => {
      db.exec(
        `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 't', 's', 'a@example.com', 'A')`,
      );
      db.exec(
        `INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m1', 't', 'u1', 'M', 0)`,
      );
    };
    const recording = (id: string, isPrimary: 0 | 1, source = 'upload') =>
      `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path)
       VALUES ('${id}', 't', 'm1', 'u1', '${source}', ${isPrimary}, 1, 'h', 1, 'audio/ogg', 'p')`;

    it('allows one primary recording per meeting, any number of others', () => {
      insertUserAndMeeting();
      db.exec(recording('r1', 1));
      db.exec(recording('r2', 0));
      db.exec(recording('r3', 0));
      expect(() => db.exec(recording('r4', 1))).toThrow(/UNIQUE constraint failed/);
    });

    it('allows one transcript per recording', () => {
      insertUserAndMeeting();
      db.exec(recording('r1', 1));
      const transcript = (id: string) =>
        `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES ('${id}', 't', 'r1', 'p', 'm', 'da', '{}')`;
      db.exec(transcript('t1'));
      expect(() => db.exec(transcript('t2'))).toThrow(/UNIQUE constraint failed/);
    });

    it('rejects enum values outside the list', () => {
      insertUserAndMeeting();
      expect(() => db.exec(recording('r1', 0, 'zoom'))).toThrow(/CHECK constraint failed/);
      expect(() => db.exec(`UPDATE meetings SET visibility = 'public' WHERE id = 'm1'`)).toThrow(
        /CHECK constraint failed/,
      );
      db.exec(seedSql('t'));
      expect(() =>
        db.exec(`UPDATE settings SET interface_language = 'de' WHERE install_id = 't'`),
      ).toThrow(/CHECK constraint failed/);
      // Nullable enum columns stay nullable.
      db.exec(`UPDATE settings SET identity_provider = NULL WHERE install_id = 't'`);
    });
  });

  it('upgrades a populated packet-1 database through 0001 to 0011 without losing a row', async () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(await readFile(new URL('0000_init.sql', migrationsDir), 'utf8'));
    old.exec(
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 't', 's', 'a@example.com', 'A');
       INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m1', 't', 'u1', 'MØDE ÆRØ ÅR', 1000);
       INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, storage_path, status)
       VALUES ('r1', 't', 'm1', 'u1', 'upload', 1, 1, 'h', 1, 'recordings/t/m1/r1.m4a', 'transcribed');
       INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES ('t1', 't', 'r1', 'p', 'm', 'da', '{}');
       INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('s1', 't', 'm1', 'Speaker 1');
       INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES
         ('g1', 't', 't1', 's1', 0, 1, 'a'), ('g2', 't', 't1', 's1', 1, 2, 'b'), ('g3', 't', 't1', 's1', 2, 3, 'c');
       INSERT INTO audit_events (id, install_id, user_id, meeting_id, action, at) VALUES ('a1', 't', 'u1', 'm1', 'opened', 1000);`,
    );
    const counts = () =>
      ['meetings', 'recordings', 'transcripts', 'speakers', 'segments', 'audit_events'].map(
        (table) => (old.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    const before = counts();
    // Packet 2's migrations, then this packet's, on the packet-1 data.
    const later = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql') && f !== '0000_init.sql')
      .sort();
    expect(later).toEqual([
      '0001_login_settings.sql',
      '0002_identity_hardening.sql',
      '0003_capture.sql',
      '0004_transcription.sql',
      '0005_transcription_claims.sql',
      '0006_access_retention.sql',
      '0007_recorder_connection.sql',
      '0008_recap.sql',
      '0009_webhooks.sql',
      '0010_api_tokens.sql',
      '0011_decision_due.sql',
    ]);
    for (const file of later) old.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
    expect(counts()).toEqual(before);
    expect(before).toEqual([1, 1, 1, 1, 3, 1]);
    // Packet-1 recordings keep working: a media type from the extension, confirmed at their start.
    expect(
      old.prepare(`SELECT content_type, created_at, confirmed_at FROM recordings`).get(),
    ).toEqual({
      content_type: 'audio/mp4',
      created_at: 1000,
      confirmed_at: 1000,
    });
    // The fold is left to the app.
    expect(old.prepare(`SELECT title_folded FROM meetings`).get()).toEqual({ title_folded: null });
    expect(old.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // 0006 indexes what is there: the title and the three segments, under the meeting.
    expect(
      old
        .prepare(
          `SELECT kind, count(*) AS n FROM meeting_search WHERE meeting_id = 'm1' GROUP BY kind`,
        )
        .all(),
    ).toEqual([
      { kind: 'segment', n: 3 },
      { kind: 'title', n: 1 },
    ]);
    expect(
      old
        .prepare(`SELECT meeting_id FROM meeting_search WHERE meeting_search MATCH 'text : "ærø"'`)
        .all(),
    ).toEqual([{ meeting_id: 'm1' }]);
  });

  it('only adds to the schema: 0003, 0006, 0008 and 0011 drop and rebuild nothing', async () => {
    for (const file of [
      '0003_capture.sql',
      '0006_access_retention.sql',
      '0008_recap.sql',
      '0011_decision_due.sql',
    ]) {
      const sql = await readFile(new URL(file, migrationsDir), 'utf8');
      expect(sql, file).not.toMatch(/DROP|__new_|RENAME|PRAGMA/i);
    }
  });

  it('folds packet-1 titles with backfillTitleKeys, once', async () => {
    const { backfillTitleKeys } = await import('../src/db/title-keys');
    db.exec(
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 't', 's', 'a@example.com', 'A');
       INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m1', 't', 'u1', 'MØDE ÆRØ ÅR', 0);
       INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at) VALUES ('m2', 't', 'u1', 'Other', 'kept', 0);
       INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m3', 'other', 'u1', 'ÆBLE', 0);`,
    );
    const orm = proxy(db);
    expect(await backfillTitleKeys(orm, 't')).toBe(1);
    expect(await backfillTitleKeys(orm, 't')).toBe(0);
    const rows = db.prepare(`SELECT id, title_folded FROM meetings ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 'm1', title_folded: 'møde ærø år' },
      { id: 'm2', title_folded: 'kept' },
      { id: 'm3', title_folded: null },
    ]);
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

describe('dev seed', () => {
  it('writes the users and a demo library that fits the schema, twice', async () => {
    const { devUsersSql, demoSql, demoMeetings, LONG_TITLE } = await import('../src/db/dev-seed');
    const db = await migratedDatabase();
    for (let run = 0; run < 2; run++) {
      db.exec(devUsersSql('dev'));
      db.exec(demoSql('dev', 30));
    }
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    // The three dev users, packet 6's 40 colleagues and the owner of the old meetings.
    expect(count(`SELECT count(*) AS n FROM users WHERE install_id = 'dev'`)).toBe(44);
    expect(count(`SELECT count(*) AS n FROM meetings WHERE owner_id = 'dev-user'`)).toBe(30);
    // Three demo meetings, the graph meeting and packet 6's two search meetings.
    expect(count(`SELECT count(*) AS n FROM meetings WHERE owner_id = 'dev-colleague'`)).toBe(6);
    // The colleague's shared meeting, the delete test's graph meeting, and demo-0001's 40.
    expect(count(`SELECT count(*) AS n FROM meeting_shares WHERE install_id = 'dev'`)).toBe(42);
    expect(count(`SELECT count(*) AS n FROM segments WHERE transcript_id = 'demo-graph-t1'`)).toBe(
      3,
    );
    // Rule 13's transcripts: 6,000 segments and 14 speakers, one with no speakers, one with no speech.
    expect(count(`SELECT count(*) AS n FROM segments WHERE transcript_id = 'demo-0002-t'`)).toBe(
      6000,
    );
    expect(count(`SELECT count(*) AS n FROM speakers WHERE meeting_id = 'demo-0002'`)).toBe(14);
    expect(count(`SELECT count(*) AS n FROM speakers WHERE meeting_id = 'demo-0004'`)).toBe(0);
    expect(count(`SELECT count(*) AS n FROM segments WHERE transcript_id = 'demo-0005-t'`)).toBe(0);
    // Packet 6: 10,000 audit rows plus the graph's one, 230 old meetings, the search index.
    expect(count(`SELECT count(*) AS n FROM audit_events WHERE install_id = 'dev'`)).toBe(10_001);
    expect(count(`SELECT count(*) AS n FROM meetings WHERE owner_id = 'dev-archivist'`)).toBe(230);
    // The index holds every demo segment, packet 4's transcripts included, and every title.
    expect(count(`SELECT count(*) AS n FROM meeting_search WHERE kind = 'segment'`)).toBe(
      count(`SELECT count(*) AS n FROM segments g
        JOIN transcripts t ON t.id = g.transcript_id AND t.is_comparison = 0
        JOIN recordings r ON r.id = t.recording_id
        WHERE g.install_id = 'dev' AND r.meeting_id LIKE 'demo%' AND trim(g.text) != ''`),
    );
    expect(
      count(
        `SELECT count(DISTINCT meeting_id) AS n FROM meeting_search WHERE meeting_search MATCH 'text : "ugeplanen"' AND meeting_id LIKE 'demo-search-%'`,
      ),
    ).toBe(2);
    // The foreign-install fixtures: one meeting, one share, one recording.
    expect(count(`SELECT count(*) AS n FROM meetings WHERE install_id = 'other-install'`)).toBe(1);
    expect(
      count(`SELECT count(*) AS n FROM meeting_shares WHERE install_id = 'other-install'`),
    ).toBe(1);
    expect(count(`SELECT count(*) AS n FROM recordings WHERE install_id = 'other-install'`)).toBe(
      1,
    );
    expect([...LONG_TITLE]).toHaveLength(120);

    const big = demoMeetings(2000);
    expect(big.filter((m) => m.ownerId === 'dev-user')).toHaveLength(2000);
    expect(big.some((m) => m.recording?.durationS === 4 * 3600)).toBe(true);
    expect(big.some((m) => m.recording === null)).toBe(true);
    expect(big.some((m) => /[æøå]/i.test(m.title))).toBe(true);
  });
});
