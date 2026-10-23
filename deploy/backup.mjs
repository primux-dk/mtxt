#!/usr/bin/env node
// Backs up an install's D1 database to SQL files, and restores one into an empty database.
//
//   node deploy/backup.mjs --config deploy/installs/<name>.json [--out <dir>]
//   node deploy/backup.mjs --config deploy/installs/<name>.json --restore <dir> --into <database>
//
// `wrangler d1 export` refuses a database with an FTS5 table, so the backup exports the
// data of every ordinary table by name and leaves the search index out. A restore applies
// the migrations the backup was taken at, imports the data, applies the newer migrations,
// and rebuilds the search index from the meetings, transcripts and recaps.
//
// Every remote call uses the install's generated wrangler config, which must match the
// install config (account, Worker, database). A restore never writes into the install's
// live database unless --into-live --yes-i-mean-it are both given, and never into a
// database that holds rows.
// For testing: --wrangler <wrangler config> --local in place of --config.
// The files hold meeting content and sealed settings: keep them like the database itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  expand,
  fail,
  loadInstall,
  parseJsonc,
  readGeneratedConfig,
  root,
  runMain,
  wranglerBin,
  writePrivateFile,
} from './lib.mjs';

const migrationsDir = join(root, 'packages/adapters/migrations');

const { values: flags } = parseArgs({
  options: {
    config: { type: 'string' },
    wrangler: { type: 'string' },
    local: { type: 'boolean', default: false },
    out: { type: 'string' },
    restore: { type: 'string' },
    into: { type: 'string' },
    'into-live': { type: 'boolean', default: false },
    'yes-i-mean-it': { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------- target

let wranglerConfig;
let baseConfig;
let env = { ...process.env };
let label;
let liveDatabaseId = null;

function target() {
  if (flags.config) {
    if (flags.local) fail('--local is for --wrangler test configs, not an install.');
    const install = loadInstall(flags.config);
    baseConfig = readGeneratedConfig(install);
    wranglerConfig = install.generatedConfig;
    liveDatabaseId = baseConfig.d1_databases[0].database_id;
    env = { ...env, CLOUDFLARE_ACCOUNT_ID: install.accountId };
    label = install.installId;
  } else if (flags.wrangler) {
    if (!flags.local) fail('--wrangler is for local test databases; pass --local.');
    wranglerConfig = expand(flags.wrangler);
    baseConfig = parseJsonc(readFileSync(wranglerConfig, 'utf8'));
    label = 'local';
  } else fail('Pass --config <install.json>, or --wrangler <config> --local.');
}
const where = () => (flags.local ? '--local' : '--remote');

function wrangler(args, configPath = wranglerConfig) {
  const result = spawnSync(wranglerBin, [...args, '--config', configPath], {
    cwd: dirname(configPath),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write((result.stderr ?? '') + (result.stdout ?? ''));
    fail(`wrangler ${args.slice(0, 3).join(' ')} failed.`);
  }
  return result.stdout;
}
const query = (sql, configPath) => {
  const out = wrangler(['d1', 'execute', 'DB', where(), '--json', '--command', sql], configPath);
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
};
const execFile = (file, configPath) =>
  wrangler(['d1', 'execute', 'DB', where(), `--file=${file}`, '--yes'], configPath);

/** Ordinary tables with data worth keeping: no SQLite, Cloudflare or migration bookkeeping, no FTS. */
function dataTables(configPath) {
  const all = query(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid`,
    configPath,
  );
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')).map((t) => t.name);
  return all
    .map((t) => t.name)
    .filter(
      (name) =>
        !/^(sqlite_|_cf_|d1_migrations$)/.test(name) &&
        !virtual.some((v) => name === v || name.startsWith(`${v}_`)),
    );
}

/** Rows per table in an export file: one `INSERT INTO "<table>"` statement per row. */
function countRows(sqlText, tables) {
  const counts = Object.fromEntries(tables.map((t) => [t, 0]));
  for (const m of sqlText.matchAll(/^INSERT INTO "([^"]+)"/gm)) {
    if (!(m[1] in counts)) fail(`the export holds rows of an unexpected table, ${m[1]}.`);
    counts[m[1]]++;
  }
  return counts;
}

/** The statements of migration 0006 that fill the search index. Update when a migration changes it. */
function rebuildSearchSql() {
  const statements = readFileSync(join(migrationsDir, '0006_access_retention.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('INSERT INTO `meeting_search`'));
  if (statements.length !== 3) fail('migration 0006 no longer holds the three index inserts.');
  return ['DELETE FROM `meeting_search`;', ...statements].join('\n') + '\n';
}

// ---------------------------------------------------------------- backup

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = expand(flags.out ?? `backups/${label}-${stamp}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const tables = dataTables();
  const migrations = query(`SELECT name FROM d1_migrations ORDER BY id`).map((r) => r.name);
  const dataFile = join(out, 'data.sql');
  wrangler([
    'd1',
    'export',
    'DB',
    where(),
    '--no-schema',
    ...tables.flatMap((t) => ['--table', t]),
    '--output',
    dataFile,
  ]);
  // The counts are the export's own, so the restore checks against the snapshot it imports.
  const counts = countRows(readFileSync(dataFile, 'utf8'), tables);
  writePrivateFile(
    join(out, 'manifest.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), migrations, counts }, null, 2) + '\n',
  );
  console.log(`Backup in ${out}`);
  console.log(
    `  ${tables.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`,
  );
  console.log(`  at migration ${migrations.at(-1)}; the search index is rebuilt on restore`);
}

// ---------------------------------------------------------------- restore

/** The database to restore into, as a wrangler D1 entry, after the live-database guard. */
function restoreTarget() {
  const db = { ...baseConfig.d1_databases[0] };
  if (flags.local) return db;
  if (!flags.into) fail('--restore needs --into <database name>, an empty D1 database.');
  if (!/^mtxt-[a-z0-9-]{1,58}$/.test(flags.into)) fail('--into must name an mtxt- database.');
  const list = JSON.parse(wrangler(['d1', 'list', '--json']));
  const found = list.find((d) => d.name === flags.into);
  if (!found) {
    fail(
      `no D1 database "${flags.into}". Create it: "$MTXT_WRANGLER" d1 create ${flags.into} --jurisdiction eu -c "$MTXT_CFG" (deploy/README.md)`,
    );
  }
  if (found.uuid === liveDatabaseId && !(flags['into-live'] && flags['yes-i-mean-it'])) {
    fail(
      `"${flags.into}" is the install's live database. Restore into a new one, or pass --into-live --yes-i-mean-it.`,
    );
  }
  return { ...db, database_name: found.name, database_id: found.uuid };
}

/** Refuses a target that holds any row, or migrations the backup does not have. */
function assertEmpty(configPath, manifest) {
  const applied = query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'`,
    configPath,
  ).length
    ? query(`SELECT name FROM d1_migrations ORDER BY id`, configPath).map((r) => r.name)
    : [];
  if (applied.some((m, i) => manifest.migrations[i] !== m)) {
    fail('the target database has migrations the backup was not taken at. Use a new database.');
  }
  const full = dataTables(configPath).filter(
    (t) => query(`SELECT count(*) AS n FROM "${t}"`, configPath)[0].n > 0,
  );
  if (full.length) fail(`the target database is not empty: ${full.join(', ')} hold rows.`);
}

function restore() {
  const dir = expand(flags.restore);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const known = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (manifest.migrations.some((m, i) => known[i] !== m)) {
    fail('the backup was taken at migrations this checkout does not have in that order.');
  }
  const db = restoreTarget();

  // A config for the target, first with the backup's migrations only.
  const temp = mkdtempSync(join(tmpdir(), 'mtxt-restore-'));
  const partial = join(temp, 'migrations');
  mkdirSync(partial);
  for (const m of manifest.migrations) copyFileSync(join(migrationsDir, m), join(partial, m));
  const targetConfig = join(dirname(wranglerConfig), `wrangler.restore-${process.pid}.jsonc`);
  const writeTarget = (migrations_dir) =>
    writePrivateFile(
      targetConfig,
      JSON.stringify({ ...baseConfig, d1_databases: [{ ...db, migrations_dir }] }, null, 2),
    );

  try {
    writeTarget(partial);
    assertEmpty(targetConfig, manifest);
    wrangler(['d1', 'migrations', 'apply', 'DB', where()], targetConfig);
    execFile(join(dir, 'data.sql'), targetConfig);
    writeTarget(migrationsDir);
    wrangler(['d1', 'migrations', 'apply', 'DB', where()], targetConfig);
    const rebuild = join(temp, 'rebuild-search.sql');
    writePrivateFile(rebuild, rebuildSearchSql());
    execFile(rebuild, targetConfig);

    const mismatched = Object.entries(manifest.counts).filter(
      ([t, n]) => query(`SELECT count(*) AS n FROM "${t}"`, targetConfig)[0].n !== n,
    );
    if (mismatched.length) {
      fail(`row counts differ after the restore: ${mismatched.map(([t]) => t).join(', ')}`);
    }
    const indexed = query(`SELECT count(*) AS n FROM meeting_search`, targetConfig)[0].n;
    console.log(`Restored ${Object.keys(manifest.counts).length} tables; every row count matches.`);
    console.log(`  search index rebuilt: ${indexed} rows`);
    if (!flags.local && db.database_id !== liveDatabaseId) {
      console.log(
        `  Point the install at it: set "names": { "database": "${db.database_name}" } in`,
      );
      console.log('  the install config and run pnpm deploy:install --config <it> again.');
    }
  } finally {
    rmSync(targetConfig, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

await runMain(async () => {
  target();
  if (flags.restore) restore();
  else backup();
});
