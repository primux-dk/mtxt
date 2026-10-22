// Applies the migrations before --from to a fresh local D1, writes a packet-1
// graph (meeting, recording, transcript, speaker, three segments), applies
// the rest, and fails if a row is gone. Runs in a temporary folder, never on
// the dev database.
//   node scripts/d1-upgrade-check.mjs --from 0001_capture.sql
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const from = process.argv[process.argv.indexOf('--from') + 1];
if (!from || !from.endsWith('.sql')) throw new Error('Pass --from <first migration to test>.');
const source = new URL('../../../packages/adapters/migrations/', import.meta.url).pathname;
const all = readdirSync(source)
  .filter((f) => f.endsWith('.sql'))
  .sort();
if (!all.includes(from)) throw new Error(`${from} is not in ${source}`);

const dir = mkdtempSync(join(tmpdir(), 'mtxt-d1-upgrade-'));
const migrations = join(dir, 'migrations');
mkdirSync(migrations);
writeFileSync(
  join(dir, 'wrangler.jsonc'),
  JSON.stringify({
    name: 'upgrade-check',
    compatibility_date: '2026-10-01',
    d1_databases: [
      { binding: 'DB', database_name: 'check', database_id: 'check', migrations_dir: 'migrations' },
    ],
  }),
);
const wrangler = (...args) =>
  execFileSync(
    'wrangler',
    [
      ...args,
      '--local',
      '--persist-to',
      join(dir, 'state'),
      '--config',
      join(dir, 'wrangler.jsonc'),
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
const apply = (files) => {
  for (const f of files) cpSync(join(source, f), join(migrations, f));
  wrangler('d1', 'migrations', 'apply', 'DB');
};
const query = (sql) =>
  JSON.parse(wrangler('d1', 'execute', 'DB', '--json', '--command', sql))[0].results;
const COUNT = `SELECT
  (SELECT count(*) FROM meetings) AS meetings, (SELECT count(*) FROM recordings) AS recordings,
  (SELECT count(*) FROM transcripts) AS transcripts, (SELECT count(*) FROM speakers) AS speakers,
  (SELECT count(*) FROM segments) AS segments`;

try {
  apply(all.slice(0, all.indexOf(from)));
  query(`INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 'dev', 's', 'a@example.com', 'A');
    INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m1', 'dev', 'u1', 'MØDE ÆRØ ÅR', 1000);
    INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, storage_path, status)
      VALUES ('r1', 'dev', 'm1', 'u1', 'upload', 1, 1, 'h', 1, 'recordings/dev/m1/r1.mp3', 'transcribed');
    INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES ('t1', 'dev', 'r1', 'p', 'm', 'da', '{}');
    INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('s1', 'dev', 'm1', 'Speaker 1');
    INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text)
      VALUES ('g1', 'dev', 't1', 's1', 0, 1, 'a'), ('g2', 'dev', 't1', 's1', 1, 2, 'b'), ('g3', 'dev', 't1', 's1', 2, 3, 'c');`);
  const before = query(COUNT)[0];
  apply(all.slice(all.indexOf(from)));
  const after = query(COUNT)[0];
  const recording = query(`SELECT content_type, created_at, confirmed_at FROM recordings`)[0];
  console.log(`applied: ${all.join(', ')}`);
  console.log('before', JSON.stringify(before));
  console.log('after ', JSON.stringify(after));
  console.log('recording', JSON.stringify(recording));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Rows were lost in the upgrade.');
  if (recording.content_type !== 'audio/mpeg' || recording.confirmed_at !== 1000) {
    throw new Error('The packet-1 recording was not backfilled.');
  }
  console.log('D1 upgrade check passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
