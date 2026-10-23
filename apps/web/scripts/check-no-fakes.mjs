// Fails when the production Worker carries the e2e run's fake providers
// (docs/decisions.md, packet 4 review). Run after a production build:
//   pnpm build:cf && pnpm --filter @mtxt/web check:no-fakes
// It bundles the Worker the way `wrangler deploy` does (--dry-run, the
// wrangler.jsonc define MTXT_E2E_BUILD = "") and greps that bundle and the
// OpenNext output for the fakes' names.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const NAMES = [
  'fakeAssemblyAiUrl',
  'fakeSpeech',
  'WORKERS_AI_FAKE_URL',
  'ASSEMBLYAI_BASE_URL',
  'fakeElevenLabsUrl',
  'ELEVENLABS_BASE_URL',
  'fakeRecapLlm',
  'RECAP_FAKE_URL',
  'fakeReceiverRoute',
];

const openNext = join(here, '.open-next');
if (!existsSync(join(openNext, 'worker.js'))) {
  throw new Error('No .open-next build. Run `pnpm build:cf` (not build:e2e) first.');
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(m?js|cjs)$/.test(name) ? [path] : [];
  });
}

const out = mkdtempSync(join(tmpdir(), 'mtxt-no-fakes-'));
try {
  execFileSync('wrangler', ['deploy', '--dry-run', '--outdir', out], {
    cwd: here,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const found = [];
  for (const file of [...files(out), ...files(openNext)]) {
    const text = readFileSync(file, 'utf8');
    if (
      text.includes('/api/test/fake-assemblyai') ||
      text.includes('/api/test/fake-elevenlabs') ||
      text.includes('/api/test/fake-recap') ||
      text.includes('/api/test/webhook-receiver')
    )
      found.push(`${file}: a fake route (an e2e build?)`);
    for (const name of NAMES) if (text.includes(name)) found.push(`${file}: ${name}`);
  }
  if (found.length) {
    console.error(`The production Worker carries test code:\n${found.join('\n')}`);
    process.exit(1);
  }
  console.log(`No fake providers in the production Worker (${NAMES.join(', ')}).`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
