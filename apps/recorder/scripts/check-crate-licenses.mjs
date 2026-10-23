#!/usr/bin/env node
/* global console, process, URL */
// The Rust side of `pnpm check:licenses`: every crate the recorder ships
// (normal dependencies of mtxt-recorder for macOS, both architectures) must be
// under MIT, Apache-2.0, BSD, ISC or another licence in ALLOWED. A crate with
// a licence that needs a note is listed in NOTED with the reason; anything
// else, and every GPL or LGPL crate without a permissive alternative, fails.
// Build-time crates (build scripts, proc macros) are listed for information.
//
//   node apps/recorder/scripts/check-crate-licenses.mjs [--list]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(new URL('../src-tauri/Cargo.toml', import.meta.url));
const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'MIT-0',
  'Zlib',
  'BSL-1.0',
  'Apache-2.0 WITH LLVM-exception',
]);
// Permissive, but not in the repository's list: each is named in NOTICE.md.
const NOTED = {
  'Unicode-3.0': 'Unicode data tables (ICU4X and unicode-ident); a permissive data licence.',
  Unlicense: 'whisper-rs and whisper-rs-sys: a public-domain dedication.',
  'CDLA-Permissive-2.0': 'webpki-roots: Mozilla root certificates as data.',
  'MPL-2.0': 'Used unmodified through Tauri (file-level copyleft); listed in NOTICE.md.',
};

const meta = JSON.parse(
  execFileSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--manifest-path',
      manifest,
      '--filter-platform',
      'aarch64-apple-darwin',
      '--filter-platform',
      'x86_64-apple-darwin',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  ),
);
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const root = meta.packages.find((p) => p.name === 'mtxt-recorder').id;

function walk(start, kinds) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => kinds.includes(k.kind ?? 'normal'))) stack.push(dep.pkg);
    }
  }
  seen.delete(start);
  return seen;
}

const runtime = walk(root, ['normal']);
const all = walk(root, ['normal', 'build']);
const buildOnly = [...all].filter((id) => !runtime.has(id));

function verdict(expr) {
  if (!expr) return 'unknown';
  const clean = expr.replaceAll('/', ' OR ').replace(/[()]/g, ' ').trim();
  const alternatives = clean
    .split(/\s+OR\s+/)
    .map((a) => a.split(/\s+AND\s+/).map((s) => s.trim()));
  if (alternatives.some((alt) => alt.every((id) => ALLOWED.has(id)))) return 'ok';
  if (alternatives.some((alt) => alt.every((id) => ALLOWED.has(id) || id in NOTED))) return 'noted';
  return 'refused';
}

const rows = [...runtime]
  .map((id) => pkgs.get(id))
  .map((p) => ({
    name: p.name,
    version: p.version,
    license: p.license ?? '(none)',
    v: verdict(p.license),
  }));
rows.sort((a, b) => a.name.localeCompare(b.name));
const refused = rows.filter((r) => r.v === 'refused' || r.v === 'unknown');
const noted = rows.filter((r) => r.v === 'noted');

if (process.argv.includes('--list')) {
  for (const r of rows) console.log(`${r.name} ${r.version}\t${r.license}`);
  console.log(`\nbuild-time only: ${buildOnly.length} crates`);
}
const byLicence = {};
for (const r of rows) byLicence[r.license] = (byLicence[r.license] ?? 0) + 1;
console.log(`${rows.length} runtime crates`);
for (const [l, n] of Object.entries(byLicence).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(4)}  ${l}`);
if (noted.length) {
  console.log('\nNoted (permissive, named in NOTICE.md):');
  for (const r of noted) console.log(`  ${r.name} ${r.version}: ${r.license}`);
}
if (refused.length) {
  console.error('\nRefused:');
  for (const r of refused) console.error(`  ${r.name} ${r.version}: ${r.license}`);
  process.exit(1);
}
