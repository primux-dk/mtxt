// Writes the default settings row into the install's D1 database.
//   pnpm db:seed              local D1 (the one `pnpm dev` and `wrangler dev` use),
//                             plus the three dev users AUTH_TEST_MODE signs in as
//   pnpm db:seed --demo       also replaces the dev users' meetings with a demo
//                             library of 2,000 meetings (behaviour.md rule 13)
//   pnpm db:seed --demo=30    the same with 30 meetings, as the e2e test uses
//   pnpm db:seed --remote     the deployed install's D1 (needs wrangler login);
//                             settings only, never users or demo data
// Idempotent: an existing settings row and existing users are left alone. Run
// `pnpm db:migrate` first.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSql } from '../../../packages/adapters/src/db/seed.ts';
import { demoSql, devUsersSql } from '../../../packages/adapters/src/db/dev-seed.ts';

const remote = process.argv.includes('--remote');
// `--persist-to <dir>` picks a local state folder other than the default (the e2e run uses its own).
const persistAt = process.argv.indexOf('--persist-to');
const persist = persistAt > -1 ? ['--persist-to', process.argv[persistAt + 1]] : [];
const demoArg = process.argv.find((a) => a === '--demo' || a.startsWith('--demo='));
const demoCount = demoArg ? Number(demoArg.split('=')[1] ?? 2000) : 0;
if (remote && demoArg) throw new Error('--demo writes test data; it never runs with --remote.');
if (demoArg && !(Number.isInteger(demoCount) && demoCount > 0)) {
  throw new Error(`--demo takes a positive number of meetings: ${demoArg}`);
}

// INSTALL_ID from the environment, else from wrangler.jsonc's vars.
const wranglerConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const installId =
  process.env.INSTALL_ID ?? wranglerConfig.match(/"INSTALL_ID"\s*:\s*"([^"]+)"/)?.[1];
if (!installId) throw new Error('No INSTALL_ID in the environment or in wrangler.jsonc vars.');

let sql = seedSql(installId);
if (!remote) sql += devUsersSql(installId);
if (demoCount) sql += demoSql(installId, demoCount);

const dir = mkdtempSync(join(tmpdir(), 'mtxt-seed-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, sql);
try {
  execFileSync(
    'wrangler',
    ['d1', 'execute', 'DB', remote ? '--remote' : '--local', ...persist, `--file=${file}`, '--yes'],
    { stdio: 'inherit' },
  );
  console.log(
    `Settings row for install "${installId}" is in place (${remote ? 'remote' : 'local'}).` +
      (remote ? '' : ' Dev users are in place.') +
      (demoCount ? ` Demo library: ${demoCount} meetings.` : ''),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
