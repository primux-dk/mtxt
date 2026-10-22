/**
 * Demo data for packet 6 (visibility, retention, audit, search), appended to
 * the demo library by demoSql(). Behaviour rule 13: a meeting shared with 40
 * colleagues, 10,000 audit rows, and enough old meetings that one retention
 * night needs several batches. Names are invented. Never written to a
 * deployed install. Plain .ts imports only, like dev-seed.ts.
 */
import { DEV_USERS } from './dev-seed.ts';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** The search index's meeting key (search.ts meetingKey), as SQL. */
const meetingKeySql = (id: string) => `'m' || lower(hex(${quote(id)}))`;

const FIRST = [
  'Sofie',
  'Mads',
  'Ida',
  'Frederik',
  'Clara',
  'Oskar',
  'Freja',
  'Emil',
  'Asta',
  'Søren',
];
const LAST = [
  'Østergaard',
  'Bæk',
  'Nørgaard',
  'Ravn',
  'Kjær',
  'Lund',
  'Dahl',
  'Holm',
  'Krog',
  'Brandt',
];

/** 40 colleagues, so a meeting can be shared with all of them. */
export const DEMO_PEOPLE = Array.from({ length: 40 }, (_, i) => {
  const first = FIRST[i % FIRST.length]!;
  const last = LAST[(i * 3 + Math.floor(i / 10)) % LAST.length]!;
  const n = String(i + 1).padStart(2, '0');
  return {
    id: `demo-person-${n}`,
    name: `${first} ${last}`,
    email: `${first.toLowerCase().replace('ø', 'o')}.${n}@example.com`,
  };
});

/** The dev user's meeting the 40 are named on. Index 1 is `shared` in demoMeetings(). */
export const SHARED_WITH_FORTY = 'demo-0001';

/** Meetings of the colleague with a transcript, for the search tests: one company-wide, one private. */
export const SEARCH_MEETINGS = {
  company: 'demo-search-company',
  private: 'demo-search-private',
} as const;
const SEARCH_TITLES = { company: 'Linjemøde, alle', private: 'Linjemøde, kun ejeren' } as const;

const SEGMENTS = [
  'Så er vi samlet. Lad os begynde med kapaciteten på linje 2. Jonas, hvor står vi med testen?',
  'Testen kører, men vi mangler to operatører i aftenholdet.',
  'Godt. Så aftaler vi, at Søren melder tilbage fredag. Anne, vil du samle tallene i ugeplanen?',
];

/** Old meetings of a fourth user, past both deadlines: more than two retention batches. */
export const RETENTION_FIXTURES = 230;
export const RETENTION_OWNER = 'dev-archivist';

export const AUDIT_ROWS = 10_000;

function insertRows(table: string, columns: string[], rows: string[][]): string {
  let sql = '';
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    sql += `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${batch.map((r) => `(${r.join(', ')})`).join(',\n')};\n`;
  }
  return sql;
}

function generator(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * SQL for packet 6's demo rows. `meetingIds` are the demo library's meetings
 * (for audit rows), `now` the demo library's newest start.
 */
export function accessDemoSql(
  installId: string,
  meetings: readonly { id: string; ownerId: string; title: string; visibility: string }[],
  now: number,
): string {
  const iid = quote(installId);
  const [dev, colleague] = DEV_USERS;
  const day = 86_400_000;
  let sql = '';

  // Reseeding: what this file writes goes first. Meetings were deleted by demoSql already.
  sql += `DELETE FROM audit_events WHERE install_id = ${iid} AND id LIKE 'demo-audit-%';\n`;
  sql += `DELETE FROM meeting_search WHERE install_id = ${iid} AND meeting_id LIKE 'demo%';\n`;
  sql += `DELETE FROM meetings WHERE install_id = ${iid} AND owner_id = ${quote(RETENTION_OWNER)};\n`;

  sql += insertRows(
    'users',
    ['id', 'install_id', 'oidc_subject', 'email', 'name', 'is_admin'],
    [
      ...DEMO_PEOPLE.map((p) => [
        quote(p.id),
        iid,
        quote(`test|${p.email}`),
        quote(p.email),
        quote(p.name),
        '0',
      ]),
      [
        quote(RETENTION_OWNER),
        iid,
        quote('test|archivist@example.com'),
        quote('archivist@example.com'),
        quote('Karen Arkiv'),
        '0',
      ],
    ],
  ).replaceAll(';\n', ' ON CONFLICT (id) DO NOTHING;\n');

  sql += insertRows(
    'meeting_shares',
    ['install_id', 'meeting_id', 'user_id'],
    DEMO_PEOPLE.map((p) => [iid, quote(SHARED_WITH_FORTY), quote(p.id)]),
  );

  // Two meetings of the colleague with a transcript: the dev user finds the company one only.
  for (const [visibility, id] of Object.entries(SEARCH_MEETINGS)) {
    const t = now - 2 * day;
    sql +=
      [
        `INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES (${quote(id)}, ${iid}, ${quote(colleague.id)}, ${quote(SEARCH_TITLES[visibility as keyof typeof SEARCH_TITLES])}, ${quote(SEARCH_TITLES[visibility as keyof typeof SEARCH_TITLES].toLocaleLowerCase())}, ${t}, ${quote(visibility)});`,
        `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at) VALUES (${quote(`${id}-r1`)}, ${iid}, ${quote(id)}, ${quote(colleague.id)}, 'upload', 1, 2526, '${'0'.repeat(64)}', 1, 'audio/webm', ${quote(`recordings/${installId}/${id}/${id}-r1.webm`)}, 'transcribed', ${t}, ${t});`,
        `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES (${quote(`${id}-t1`)}, ${iid}, ${quote(`${id}-r1`)}, 'demo', 'demo', 'da', '{}');`,
        ...SEGMENTS.map(
          (text, i) =>
            `INSERT INTO segments (id, install_id, transcript_id, start_ms, end_ms, text) VALUES (${quote(`${id}-g${i}`)}, ${iid}, ${quote(`${id}-t1`)}, ${i * 600_000 + 18_000}, ${i * 600_000 + 30_000}, ${quote(text)});`,
        ),
      ].join('\n') + '\n';
  }

  // The search index: every demo title, and the two transcripts.
  const titled = [
    ...meetings.map((m) => [m.id, m.title] as const),
    ...Object.entries(SEARCH_MEETINGS).map(
      ([v, id]) => [id, SEARCH_TITLES[v as keyof typeof SEARCH_TITLES]] as const,
    ),
    ['demo-graph', 'Møde med alt i'] as const,
  ];
  sql += insertRows(
    'meeting_search',
    ['install_id', 'meeting_id', 'meeting_key', 'kind', 'ref', 'text'],
    [
      ...titled.map(([id, title]) => [
        iid,
        quote(id),
        meetingKeySql(id),
        "'title'",
        quote(id),
        quote(title),
      ]),
      ...Object.values(SEARCH_MEETINGS).flatMap((id) =>
        SEGMENTS.map((text, i) => [
          iid,
          quote(id),
          meetingKeySql(id),
          "'segment'",
          quote(`${id}-g${i}`),
          quote(text),
        ]),
      ),
    ],
  );

  // Old meetings for the retention batches: audio paths with no object behind them.
  const old = Array.from({ length: RETENTION_FIXTURES }, (_, i) => {
    const id = `demo-old-${String(i).padStart(3, '0')}`;
    return { id, startedAt: now - (400 + i) * day };
  });
  sql += insertRows(
    'meetings',
    ['id', 'install_id', 'owner_id', 'title', 'title_folded', 'started_at', 'visibility'],
    old.map((m, i) => [
      quote(m.id),
      iid,
      quote(RETENTION_OWNER),
      quote(`Gammelt møde ${i + 1}`),
      quote(`gammelt møde ${i + 1}`),
      String(m.startedAt),
      "'private'",
    ]),
  );
  sql += insertRows(
    'recordings',
    [
      'id',
      'install_id',
      'meeting_id',
      'uploaded_by',
      'source',
      'is_primary',
      'duration_s',
      'sha256',
      'size_bytes',
      'content_type',
      'storage_path',
      'status',
      'created_at',
      'confirmed_at',
    ],
    old.map((m) => [
      quote(`${m.id}-r1`),
      iid,
      quote(m.id),
      quote(RETENTION_OWNER),
      "'upload'",
      '1',
      '60',
      quote('0'.repeat(64)),
      '1',
      "'audio/webm'",
      quote(`recordings/${installId}/${m.id}/${m.id}-r1.webm`),
      "'transcribed'",
      String(m.startedAt),
      String(m.startedAt),
    ]),
  );

  // 10,000 audit rows over the 90 days before `now`, newest first in the log.
  const random = generator(AUDIT_ROWS);
  const people = [dev.id, colleague.id, DEV_USERS[2].id, ...DEMO_PEOPLE.map((p) => p.id)];
  const readable = meetings.filter((m) => m.visibility !== 'private');
  const rows: string[][] = [];
  for (let i = 0; i < AUDIT_ROWS; i++) {
    const at = now - Math.floor((i / AUDIT_ROWS) * 90 * day) - Math.floor(random() * 3_600_000);
    const roll = random();
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const id = quote(`demo-audit-${String(i).padStart(5, '0')}`);
    if (roll < 0.04) {
      // A meeting deleted since: no meeting id, the title it had.
      const owner = pick([dev.id, colleague.id]);
      rows.push([
        id,
        iid,
        quote(owner),
        'NULL',
        quote(`Slettet møde ${i}`),
        "'deleted'",
        'NULL',
        String(at),
      ]);
      continue;
    }
    const meeting = roll < 0.74 ? pick(readable) : pick(meetings);
    const owner = meeting.ownerId;
    if (roll < 0.74) {
      const reader = pick(people.filter((p) => p !== owner));
      rows.push([
        id,
        iid,
        quote(reader),
        quote(meeting.id),
        quote(meeting.title),
        "'opened'",
        'NULL',
        String(at),
      ]);
    } else if (roll < 0.84) {
      const a = pick(DEMO_PEOPLE).id;
      const details = JSON.stringify({ before: [], after: [a] });
      rows.push([
        id,
        iid,
        quote(owner),
        quote(meeting.id),
        quote(meeting.title),
        "'shared'",
        quote(details),
        String(at),
      ]);
    } else if (roll < 0.92) {
      const details = JSON.stringify({ before: 'private', after: pick(['shared', 'company']) });
      rows.push([
        id,
        iid,
        quote(owner),
        quote(meeting.id),
        quote(meeting.title),
        "'visibility_changed'",
        quote(details),
        String(at),
      ]);
    } else if (roll < 0.98) {
      rows.push([
        id,
        iid,
        quote(owner),
        quote(meeting.id),
        quote(meeting.title),
        "'exported'",
        'NULL',
        String(at),
      ]);
    } else {
      rows.push([
        id,
        iid,
        quote(owner),
        quote(meeting.id),
        quote(meeting.title),
        "'mcp_read'",
        'NULL',
        String(at),
      ]);
    }
  }
  sql += insertRows(
    'audit_events',
    ['id', 'install_id', 'user_id', 'meeting_id', 'meeting_title', 'action', 'details', 'at'],
    rows,
  );
  return sql;
}
