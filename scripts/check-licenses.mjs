#!/usr/bin/env node
// Fails when a runtime dependency (anything under "dependencies", transitively)
// carries a licence outside the allowed list. Dev-only tools are listed for
// information: they run as separate programs at build time and are not shipped.
//
// A package with another licence is not allowed by widening ALLOWED. It goes in
// scripts/license-exceptions.json by name, with its licence and the reason, and
// into the PR report for the lead to decide.
//
//   node scripts/check-licenses.mjs           runtime check (CI)
//   node scripts/check-licenses.mjs --dev     also print dev-only licences outside the list
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'OFL-1.1',
]);

const exceptions = JSON.parse(
  readFileSync(new URL('./license-exceptions.json', import.meta.url), 'utf8'),
);

/** SPDX: `A OR B` passes when one side passes; `A AND B` needs both. */
function allowed(expression) {
  const clean = expression.replace(/[()]/g, ' ').trim();
  return clean
    .split(/\s+OR\s+/)
    .some((alternative) => alternative.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

function list(scope) {
  const out = execFileSync('pnpm', ['-r', 'licenses', 'list', '--json', scope], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicence = JSON.parse(out || '{}');
  return Object.entries(byLicence).flatMap(([licence, packages]) =>
    packages.map((p) => ({ name: p.name, versions: p.versions, licence })),
  );
}

const runtime = list('--prod');
const failures = [];
const excepted = [];
for (const pkg of runtime) {
  if (allowed(pkg.licence)) continue;
  const exception = exceptions[pkg.name];
  if (exception && exception.license === pkg.licence) excepted.push({ ...pkg, ...exception });
  else failures.push(pkg);
}

console.log(`Checked ${runtime.length} runtime packages.`);
if (excepted.length) {
  console.log('\nNamed exceptions (scripts/license-exceptions.json):');
  for (const p of excepted)
    console.log(`  ${p.name}@${p.versions.join(',')}  ${p.licence}  ${p.reason}`);
}

if (process.argv.includes('--dev')) {
  const runtimeNames = new Set(runtime.map((p) => p.name));
  const devOnly = list('--dev').filter((p) => !runtimeNames.has(p.name) && !allowed(p.licence));
  if (devOnly.length) {
    console.log('\nDev-only tools outside the list (not shipped):');
    for (const p of devOnly) console.log(`  ${p.name}@${p.versions.join(',')}  ${p.licence}`);
  }
}

if (failures.length) {
  console.error('\nRuntime dependencies with a licence outside the allowed list:');
  for (const p of failures) console.error(`  ${p.name}@${p.versions.join(',')}  ${p.licence}`);
  console.error(
    '\nRemove the dependency, or name it in scripts/license-exceptions.json and report it.',
  );
  process.exit(1);
}
console.log('\nLicence check passed.');
