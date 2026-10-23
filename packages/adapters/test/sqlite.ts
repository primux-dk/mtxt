/**
 * An in-memory SQLite database with every migration applied, behind the same
 * Drizzle driver as production (drizzle-orm/d1, on a small D1 stand-in), for
 * unit tests. node:sqlite has FTS5, as D1 does.
 * Test-only: nothing in a Worker imports this.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import type { Db } from '../src/db';
import * as schema from '../src/db/schema';

const migrationsDir = new URL('../migrations/', import.meta.url);

const bindable = (value: unknown): SQLInputValue =>
  value === undefined
    ? null
    : typeof value === 'boolean'
      ? Number(value)
      : (value as SQLInputValue);

/** The part of D1's API that drizzle-orm/d1 calls, on node:sqlite. */
function fakeD1(sqlite: DatabaseSync) {
  class Statement {
    constructor(
      readonly query: string,
      readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Statement(this.query, params);
    }
    private prepared() {
      return sqlite.prepare(this.query);
    }
    async all() {
      const results = this.prepared().all(...this.params.map(bindable));
      return { results, success: true, meta: {} };
    }
    async raw() {
      const statement = this.prepared();
      statement.setReturnArrays(true);
      return statement.all(...this.params.map(bindable));
    }
    async run() {
      const { changes } = this.prepared().run(...this.params.map(bindable));
      return { results: [], success: true, meta: { changes } };
    }
    async first() {
      return (await this.all()).results[0] ?? null;
    }
  }
  return {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export function testDb(): { db: Db; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  const db = drizzle(fakeD1(sqlite) as unknown as D1Database, { schema });
  return { db, sqlite };
}

/** Rows as objects, for assertions. */
export const rows = <T = Record<string, unknown>>(sqlite: DatabaseSync, query: string) =>
  sqlite.prepare(query).all() as T[];

export const INSTALL = 'test';
export const DAY = 86_400_000;

/** Users, a meeting per call, and its children, written straight to the database. */
export function fixtures(sqlite: DatabaseSync, installId = INSTALL) {
  const user = (id: string, name = id, isAdmin = false) =>
    sqlite
      .prepare(
        'INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, installId, `s-${id}`, `${id}@example.com`, name, isAdmin ? 1 : 0);
  const meeting = (
    id: string,
    o: {
      owner: string;
      title?: string;
      startedAt?: number;
      visibility?: string;
      keep?: boolean;
      deletedAt?: number | null;
    },
  ) =>
    sqlite
      .prepare(
        'INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility, keep, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        installId,
        o.owner,
        o.title ?? id,
        (o.title ?? id).toLocaleLowerCase(),
        o.startedAt ?? Date.UTC(2026, 9, 1),
        o.visibility ?? 'private',
        o.keep ? 1 : 0,
        o.deletedAt ?? null,
      );
  const share = (meetingId: string, userId: string) =>
    sqlite
      .prepare('INSERT INTO meeting_shares (install_id, meeting_id, user_id) VALUES (?, ?, ?)')
      .run(installId, meetingId, userId);
  const recording = (
    id: string,
    meetingId: string,
    o: { status?: string; storagePath?: string; uploadedBy?: string } = {},
  ) =>
    sqlite
      .prepare(
        `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at)
         VALUES (?, ?, ?, (SELECT owner_id FROM meetings WHERE id = ?), 'upload', 0, 60, ?, 1, 'audio/webm', ?, ?, 1, 1)`,
      )
      .run(
        id,
        installId,
        meetingId,
        meetingId,
        '0'.repeat(64),
        o.storagePath ?? `recordings/${installId}/${meetingId}/${id}.webm`,
        o.status ?? 'transcribed',
      );
  /** A transcript on the recording with one segment per text, 10 s apart. */
  const transcript = (id: string, recordingId: string, texts: string[]) => {
    sqlite
      .prepare(
        "INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES (?, ?, ?, 'test', 'test', 'da', '{}')",
      )
      .run(id, installId, recordingId);
    texts.forEach((text, i) =>
      sqlite
        .prepare(
          'INSERT INTO segments (id, install_id, transcript_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(`${id}-s${i}`, installId, id, i * 10_000, i * 10_000 + 9_000, text),
    );
    return texts.map((text, i) => ({ id: `${id}-s${i}`, text }));
  };
  const recap = (id: string, meetingId: string, bodyMd: string, docxPath: string | null = null) => {
    sqlite
      .prepare(
        'INSERT INTO recaps (id, install_id, meeting_id, body_md, docx_path) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, installId, meetingId, bodyMd, docxPath);
    sqlite
      .prepare('INSERT INTO recap_versions (id, install_id, recap_id, body_md) VALUES (?, ?, ?, ?)')
      .run(`${id}-v1`, installId, id, bodyMd);
    sqlite.prepare('UPDATE recaps SET current_version_id = ? WHERE id = ?').run(`${id}-v1`, id);
    sqlite
      .prepare("INSERT INTO decisions (id, install_id, recap_id, text) VALUES (?, ?, ?, 'x')")
      .run(`${id}-d1`, installId, id);
    return { id, bodyMd };
  };
  return { user, meeting, share, recording, transcript, recap };
}
