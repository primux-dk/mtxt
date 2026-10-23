// Applies the migrations before --from to a fresh local D1, writes a packet-1
// graph (a meeting, a transcript, a speaker, three segments, and one
// recording per audio extension), applies the rest, and fails if a row is
// gone or a recording's backfilled media type is wrong. Runs in a temporary
// folder, never on the dev database.
//   node scripts/d1-upgrade-check.mjs --from 0001_login_settings.sql
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

/** Every extension packet 1 could have stored, and the type the backfill must give it. */
const TYPES = {
  mp3: 'audio/mpeg',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  bin: 'audio/webm',
};
const EXTENSIONS = Object.keys(TYPES);

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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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
  (SELECT count(*) FROM segments) AS segments, (SELECT count(*) FROM audit_events) AS audit`;

const recordings = EXTENSIONS.map(
  (ext, i) =>
    `('r${i + 1}', 'dev', 'm1', 'u1', 'upload', ${i === 0 ? 1 : 0}, 1, 'h', 1, ` +
    `'recordings/dev/m1/r${i + 1}.${ext}', '${i === 0 ? 'transcribed' : 'uploading'}')`,
).join(', ');

try {
  apply(all.slice(0, all.indexOf(from)));
  query(`INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('u1', 'dev', 's', 'a@example.com', 'A');
    INSERT INTO meetings (id, install_id, owner_id, title, started_at) VALUES ('m1', 'dev', 'u1', 'MØDE ÆRØ ÅR', 1000);
    INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, storage_path, status)
      VALUES ${recordings};
    INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES ('t1', 'dev', 'r1', 'p', 'm', 'da', '{}');
    INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('s1', 'dev', 'm1', 'Speaker 1');
    INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text)
      VALUES ('g1', 'dev', 't1', 's1', 0, 1, 'a'), ('g2', 'dev', 't1', 's1', 1, 2, 'b'), ('g3', 'dev', 't1', 's1', 2, 3, 'c');
    INSERT INTO audit_events (id, install_id, user_id, meeting_id, action, at) VALUES ('a1', 'dev', 'u1', 'm1', 'opened', 1000);
    INSERT INTO recaps (id, install_id, meeting_id, body_md) VALUES ('c1', 'dev', 'm1', '# Referat');
    INSERT INTO recap_versions (id, install_id, recap_id, author_id, body_md, created_at)
      VALUES ('v-b', 'dev', 'c1', 'u1', 'b', 2000), ('v-a', 'dev', 'c1', null, 'a', 1000), ('v-c', 'dev', 'c1', 'u1', 'c', 2000);
    UPDATE recaps SET current_version_id = 'v-c' WHERE id = 'c1';
    INSERT INTO decisions (id, install_id, recap_id, text) VALUES ('d2', 'dev', 'c1', 'first'), ('d1', 'dev', 'c1', 'second');`);
  const before = query(COUNT)[0];
  apply(all.slice(all.indexOf(from)));
  const after = query(COUNT)[0];
  console.log(`populated after: ${all.slice(0, all.indexOf(from)).join(', ')}`);
  console.log(`then applied:    ${all.slice(all.indexOf(from)).join(', ')}`);
  console.log('before', JSON.stringify(before));
  console.log('after ', JSON.stringify(after));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Rows were lost in the upgrade.');
  const rows = query(`SELECT storage_path, content_type, created_at, confirmed_at FROM recordings`);
  for (const row of rows) {
    const ext = row.storage_path.split('.').pop();
    const confirmedAt = ext === 'mp3' ? 1000 : null;
    console.log(
      `  .${ext.padEnd(4)} ${row.content_type.padEnd(10)} created_at ${row.created_at} confirmed_at ${row.confirmed_at}`,
    );
    if (
      row.content_type !== TYPES[ext] ||
      row.created_at !== 1000 ||
      row.confirmed_at !== confirmedAt
    ) {
      throw new Error(`The .${ext} recording was not backfilled right.`);
    }
  }
  if (rows.length !== EXTENSIONS.length) throw new Error('A recording is missing.');
  // Packet 6 (0006): the search index holds what was there, the audit row its meeting's title.
  const index = query(
    `SELECT kind, count(*) AS n FROM meeting_search WHERE meeting_id = 'm1' GROUP BY kind ORDER BY kind`,
  );
  console.log('search index', JSON.stringify(index));
  if (
    JSON.stringify(index) !==
    JSON.stringify([
      { kind: 'recap', n: 1 },
      { kind: 'segment', n: 3 },
      { kind: 'title', n: 1 },
    ])
  )
    throw new Error('The search index was not backfilled right.');
  const found = query(
    `SELECT meeting_id FROM meeting_search WHERE meeting_search MATCH 'text : "ærø"'`,
  );
  if (found.length !== 1) throw new Error('The search index does not find the title.');
  const audit = query(`SELECT meeting_title FROM audit_events WHERE id = 'a1'`)[0];
  if (audit?.meeting_title !== 'MØDE ÆRØ ÅR')
    throw new Error('The audit row has no meeting title.');
  // Packet 8 (0007) rebuilds audit_events for the recorder actions: rows, indexes and the new enum.
  const indexes = query(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_events' AND name LIKE 'audit_events_%' ORDER BY name`,
  ).map((r) => r.name);
  console.log('audit indexes', JSON.stringify(indexes));
  if (indexes.length !== 5) throw new Error('The audit indexes were not rebuilt.');
  query(
    `INSERT INTO audit_events (id, install_id, user_id, action, details, at) VALUES ('a2', 'dev', 'u1', 'recorder_connected', '{"device":"Mac"}', 2000)`,
  );
  // Packet 5 (0008): versions numbered oldest first, decisions in the order they were written.
  const versions = query(`SELECT id, number FROM recap_versions ORDER BY number`);
  console.log('recap versions', JSON.stringify(versions));
  if (JSON.stringify(versions.map((v) => v.id)) !== JSON.stringify(['v-a', 'v-b', 'v-c']))
    throw new Error('The recap versions were not numbered right.');
  const decided = query(`SELECT id, position FROM decisions ORDER BY position`);
  if (JSON.stringify(decided.map((d) => d.id)) !== JSON.stringify(['d2', 'd1']))
    throw new Error('The decisions lost their order.');
  const recap = query(`SELECT status FROM recaps WHERE id = 'c1'`)[0];
  if (recap?.status !== 'ready') throw new Error('An existing recap is not ready.');
  // Packet 13 (0009) rebuilds audit_events again for webhook_sent: every row stays.
  const audits = query(`SELECT id FROM audit_events ORDER BY id`).map((r) => r.id);
  if (JSON.stringify(audits) !== JSON.stringify(['a1', 'a2']))
    throw new Error('The audit rows did not survive the webhook rebuild.');
  query(
    `INSERT INTO audit_events (id, install_id, user_id, action, details, at) VALUES ('a3', 'dev', 'u1', 'webhook_sent', '{"endpoint":"Alex"}', 3000)`,
  );
  // Packet 16 (0010) rebuilds audit_events for the API token actions and adds kind and scope.
  const kept = query(`SELECT id FROM audit_events ORDER BY id`).map((r) => r.id);
  if (JSON.stringify(kept) !== JSON.stringify(['a1', 'a2', 'a3']))
    throw new Error('The audit rows did not survive the API token rebuild.');
  query(
    `INSERT INTO audit_events (id, install_id, user_id, action, details, at) VALUES ('a4', 'dev', 'u1', 'api_token_created', '{"name":"Alex","scope":"read"}', 4000)`,
  );
  query(
    `INSERT INTO recorder_tokens (id, install_id, user_id, device_name, token_hash, expires_at) VALUES ('t1', 'dev', 'u1', 'Mac', 'h1', 9999999999999)`,
  );
  const token = query(`SELECT kind, scope, rate_count FROM recorder_tokens WHERE id = 't1'`)[0];
  if (token?.kind !== 'recorder' || token.scope !== null || token.rate_count !== 0)
    throw new Error('A recorder token does not default to kind recorder.');
  const auto = query(`SELECT webhook_auto_send FROM settings LIMIT 1`)[0];
  if (auto && auto.webhook_auto_send !== 'off') throw new Error('Send automatically is not off.');
  console.log('D1 upgrade check passed.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
