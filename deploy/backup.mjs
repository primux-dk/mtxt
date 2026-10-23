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
// For testing: --wrangler <wrangler config> --local in place of --config.
// The files hold meeting content and sealed settings: keep them like the database itself.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web');
const wranglerBin = join(web, 'node_modules/.bin/wrangler');
const migrationsDir = join(root, 'packages/adapters/migrations');

const { values: flags } = parseArgs({
  options: {
    config: { type: 'string' },
    wrangler: { type: 'string' },
    local: { type: 'boolean', default: false },
    out: { type: 'string' },
    restore: { type: 'string' },
    into: { type: 'string' },
  },
});

function fail(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}
const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p));

// ---------------------------------------------------------------- target

let wranglerConfig;
let env = { ...process.env };
let label;
if (flags.config) {
  const install = JSON.parse(readFileSync(expand(flags.config), 'utf8'));
  wranglerConfig = join(web, `wrangler.${install.installId}.jsonc`);
  if (!existsSync(wranglerConfig)) {
    fail(`${basename(wranglerConfig)} is missing. Run deploy/install.mjs --dry-run first.`);
  }
  env = { ...env, CLOUDFLARE_ACCOUNT_ID: install.accountId };
  label = install.installId;
} else if (flags.wrangler) {
  wranglerConfig = expand(flags.wrangler);
  label = 'local';
} else fail('Pass --config <install.json>, or --wrangler <config> --local.');
const where = flags.local ? '--local' : '--remote';

function wrangler(args, configPath = wranglerConfig) {
  const result = spawnSync(wranglerBin, [...args, '--config', configPath], {
    cwd: dirname(configPath),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr + result.stdout);
    fail(`wrangler ${args.slice(0, 3).join(' ')} failed.`);
  }
  return result.stdout;
}
const query = (sql, configPath) => {
  const out = wrangler(['d1', 'execute', 'DB', where, '--json', '--command', sql], configPath);
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
};
const execFile = (file, configPath) =>
  wrangler(['d1', 'execute', 'DB', where, `--file=${file}`, '--yes'], configPath);

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
  const counts = Object.fromEntries(
    tables.map((t) => [t, query(`SELECT count(*) AS n FROM "${t}"`)[0].n]),
  );
  wrangler([
    'd1',
    'export',
    'DB',
    where,
    '--no-schema',
    ...tables.flatMap((t) => ['--table', t]),
    '--output',
    join(out, 'data.sql'),
  ]);
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify({ takenAt: new Date().toISOString(), migrations, counts }, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(`Backup in ${out}`);
  console.log(
    `  ${tables.length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`,
  );
  console.log(`  at migration ${migrations.at(-1)}; the search index is rebuilt on restore`);
}

// ---------------------------------------------------------------- restore

function restore() {
  const dir = expand(flags.restore);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const known = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (manifest.migrations.some((m, i) => known[i] !== m)) {
    fail('the backup was taken at migrations this checkout does not have in that order.');
  }

  // A config for the database to restore into, with the backup's migrations only.
  let target = wranglerConfig;
  const temp = mkdtempSync(join(tmpdir(), 'mtxt-restore-'));
  const partial = join(temp, 'migrations');
  mkdirSync(partial);
  for (const m of manifest.migrations) copyFileSync(join(migrationsDir, m), join(partial, m));
  const base = JSON.parse(
    readFileSync(wranglerConfig, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n'),
  );
  const db = { ...base.d1_databases[0], migrations_dir: partial };
  if (!flags.local) {
    if (!flags.into) fail('--restore needs --into <database name>, an empty D1 database.');
    const list = JSON.parse(wrangler(['d1', 'list', '--json']));
    const found = list.find((d) => d.name === flags.into);
    if (!found)
      fail(
        `no D1 database "${flags.into}". Create it: wrangler d1 create ${flags.into} --jurisdiction eu`,
      );
    Object.assign(db, { database_name: found.name, database_id: found.uuid });
  }
  target = join(dirname(wranglerConfig), `wrangler.restore-${process.pid}.jsonc`);
  writeFileSync(target, JSON.stringify({ ...base, d1_databases: [db] }, null, 2));
  const full = { ...db, migrations_dir: migrationsDir };

  try {
    const existing = query(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'settings'`,
      target,
    )[0].n;
    if (existing && query(`SELECT count(*) AS n FROM settings`, target)[0].n > 0) {
      fail('the target database already holds a settings row. Restore into an empty database.');
    }
    wrangler(['d1', 'migrations', 'apply', 'DB', where], target);
    execFile(join(dir, 'data.sql'), target);
    writeFileSync(target, JSON.stringify({ ...base, d1_databases: [full] }, null, 2));
    wrangler(['d1', 'migrations', 'apply', 'DB', where], target);
    const rebuild = join(temp, 'rebuild-search.sql');
    writeFileSync(rebuild, rebuildSearchSql());
    execFile(rebuild, target);

    const mismatched = Object.entries(manifest.counts).filter(
      ([t, n]) => query(`SELECT count(*) AS n FROM "${t}"`, target)[0].n !== n,
    );
    if (mismatched.length)
      fail(`row counts differ after the restore: ${mismatched.map(([t]) => t).join(', ')}`);
    const indexed = query(`SELECT count(*) AS n FROM meeting_search`, target)[0].n;
    console.log(`Restored ${Object.keys(manifest.counts).length} tables; every row count matches.`);
    console.log(`  search index rebuilt: ${indexed} rows`);
    if (!flags.local) {
      console.log(`  Point the install at it: set "names": { "database": "${flags.into}" } in the`);
      console.log('  install config and run deploy/install.mjs again.');
    }
  } finally {
    rmSync(target, { force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (flags.restore) restore();
else backup();
