// Writes the default settings row into the install's D1 database.
//   pnpm db:seed              local D1 (the one `pnpm dev` and `wrangler dev` use)
//   pnpm db:seed --remote     the deployed install's D1 (needs wrangler login)
// Idempotent: an existing row is left alone. Run `pnpm db:migrate` first.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSql } from '../../../packages/adapters/src/db/seed.ts';

const remote = process.argv.includes('--remote');

// INSTALL_ID from the environment, else from wrangler.jsonc's vars.
const wranglerConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const installId =
  process.env.INSTALL_ID ?? wranglerConfig.match(/"INSTALL_ID"\s*:\s*"([^"]+)"/)?.[1];
if (!installId) throw new Error('No INSTALL_ID in the environment or in wrangler.jsonc vars.');

const dir = mkdtempSync(join(tmpdir(), 'mtxt-seed-'));
const file = join(dir, 'seed.sql');
writeFileSync(file, seedSql(installId));
try {
  execFileSync(
    'wrangler',
    ['d1', 'execute', 'DB', remote ? '--remote' : '--local', `--file=${file}`, '--yes'],
    { stdio: 'inherit' },
  );
  console.log(
    `Settings row for install "${installId}" is in place (${remote ? 'remote' : 'local'}).`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
