/**
 * Data for local development and the end-to-end tests: three users and, with
 * `--demo`, a library big enough to break pretty layouts (behaviour.md rule
 * 13). Never written to a deployed install; the seed script refuses
 * `--remote` with these.
 *
 * Imports only plain .ts files, like seed.ts, so the seed script can load it with
 * Node's own TypeScript support. Every value is generated here, so the SQL
 * is safe to build by string.
 */
import { foldTitle } from './fold.ts';

/** The users AUTH_TEST_MODE signs in as, by `oidc_subject`. Names are invented. */
export const DEV_USERS = [
  { id: 'dev-user', subject: 'dev', email: 'dev@example.com', name: 'Mette Lund', isAdmin: true },
  {
    id: 'dev-colleague',
    subject: 'colleague',
    email: 'colleague@example.com',
    name: 'Jonas Skov',
    isAdmin: false,
  },
  {
    id: 'dev-newcomer',
    subject: 'newcomer',
    email: 'newcomer@example.com',
    name: 'Anne Holm',
    isAdmin: false,
  },
] as const;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function checkInstallId(installId: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installId)) {
    throw new Error(`Install id must be 1-64 letters, digits, _ or -: ${installId}`);
  }
}

export function devUsersSql(installId: string): string {
  checkInstallId(installId);
  return DEV_USERS.map(
    (u) =>
      `INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES ` +
      `(${quote(u.id)}, ${quote(installId)}, ${quote(u.subject)}, ${quote(u.email)}, ${quote(u.name)}, ${u.isAdmin ? 1 : 0}) ` +
      `ON CONFLICT (id) DO NOTHING;\n`,
  ).join('');
}

const TITLES = [
  'Produktionsmøde, uge {n}',
  'Leverancer og kapacitet',
  'Plan for {month}',
  'Opfølgning på linje {n}',
  'Kvalitet og nye rutiner',
  'Budget og økonomi, kvartal {q}',
  'Kundemøde i Århus',
  'Weekly sync',
  'Board meeting',
  'Design review: library {n}',
  'Ansættelsessamtale, runde {q}',
  'Strategidag på Ærø',
  'Status med lageret',
  'Retrospective, sprint {n}',
  'Sikkerhed og øvelser',
];
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august'];

/** A title of exactly 120 characters, with æ, ø and å. */
export const LONG_TITLE =
  'Årsmøde om økonomi, ansættelser, lageret og den nye produktionslinje i Ærøskøbing, med opfølgning fra bestyrelsen, del 2';

/** A small deterministic generator, so screenshots stay the same between runs. */
function generator(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface DemoMeeting {
  id: string;
  ownerId: string;
  title: string;
  startedAt: number;
  visibility: 'private' | 'shared' | 'company';
  keep: boolean;
  recording: { status: string; durationS: number; failure: string | null } | null;
  sharedWith: string[];
}

/**
 * `count` meetings for the dev user, newest on `now`, plus a tenth as many
 * from a colleague: shared with the dev user, company-wide, or private (the
 * dev user must not see those). Includes a 4-hour meeting, a 120-character
 * title, æ, ø and å, and one meeting with no recording.
 */
export function demoMeetings(count: number, now = Date.UTC(2026, 9, 22, 9, 0)): DemoMeeting[] {
  const random = generator(count);
  const meetings: DemoMeeting[] = [];
  const [dev, colleague] = DEV_USERS;
  const make = (i: number, ownerId: string, prefix: string): DemoMeeting => {
    const template = TITLES[i % TITLES.length]!;
    const title = template
      .replace('{n}', String((i % 52) + 1))
      .replace('{q}', String((i % 4) + 1))
      .replace('{month}', MONTHS[i % MONTHS.length]!);
    // About two meetings a working day, going back from `now`.
    const startedAt = now - i * 11 * 3600_000 - Math.floor(random() * 3) * 3600_000;
    const roll = random();
    const status = roll < 0.08 ? 'failed' : roll < 0.2 ? 'transcribing' : 'transcribed';
    return {
      id: `${prefix}-${String(i).padStart(4, '0')}`,
      ownerId,
      title,
      startedAt,
      visibility: i % 5 === 1 ? 'shared' : i % 7 === 2 ? 'company' : 'private',
      keep: i % 11 === 0,
      recording: {
        status,
        durationS: 300 + Math.floor(random() * 3300),
        failure: status === 'failed' ? 'stt_failed' : null,
      },
      sharedWith: [],
    };
  };

  for (let i = 0; i < count; i++) meetings.push(make(i, dev.id, 'demo'));
  // The fixtures from behaviour.md rule 13, at fixed places near the top.
  if (meetings[0]) meetings[0].title = 'Produktionsmøde, uge 43';
  if (meetings[1]) meetings[1].title = LONG_TITLE;
  if (meetings[2])
    meetings[2].recording = { status: 'transcribed', durationS: 4 * 3600, failure: null };
  if (meetings[2]) meetings[2].title = 'Strategidag, hele dagen';
  if (meetings[3]) {
    meetings[3].title = 'Planlægning uden optagelse';
    meetings[3].recording = null;
  }

  const others = Math.max(3, Math.round(count / 10));
  for (let i = 0; i < others; i++) {
    const m = make(i + 1, colleague.id, 'demo-colleague');
    m.visibility = (['shared', 'company', 'private'] as const)[i % 3]!;
    if (m.visibility === 'shared') m.sharedWith = [dev.id];
    meetings.push(m);
  }
  return meetings;
}

function insertRows(table: string, columns: string[], rows: string[][]): string {
  let sql = '';
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    sql += `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${batch.map((r) => `(${r.join(', ')})`).join(',\n')};\n`;
  }
  return sql;
}

/** The second install the fixtures plant rows from. Nothing of it may show in the first. */
export const FOREIGN_INSTALL = 'other-install';

/**
 * Rows from another install that point into this one: a company meeting of
 * its own, a share that names the newcomer on the colleague's shared
 * meeting, and a recording attached to the dev user's first meeting. The
 * schema allows these references; every query must ignore them.
 */
function foreignInstallSql(installId: string): string {
  const other = quote(FOREIGN_INSTALL);
  return (
    [
      `DELETE FROM meetings WHERE id = 'foreign-meeting';`,
      `INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES ('foreign-user', ${other}, 'foreign', 'foreign@example.com', 'Foreign User') ON CONFLICT (id) DO NOTHING;`,
      `INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES ('foreign-meeting', ${other}, 'foreign-user', 'Fremmed møde', 'fremmed møde', ${Date.UTC(2026, 9, 22, 8)}, 'company');`,
      `INSERT INTO meeting_shares (install_id, meeting_id, user_id) VALUES (${other}, 'demo-colleague-0001', 'dev-newcomer');`,
      `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at) VALUES ` +
        `('foreign-recording', ${other}, 'demo-0000', 'foreign-user', 'upload', 0, 60, '${'0'.repeat(64)}', 1, 'audio/webm', 'recordings/${FOREIGN_INSTALL}/demo-0000/foreign-recording.webm', 'transcribed', 1, 1);`,
      `-- install ${installId} must not see any of the above`,
    ].join('\n') + '\n'
  );
}

/**
 * SQL that replaces the dev users' meetings with the demo library. Deleting
 * first keeps the counts the e2e test checks the same on every run.
 */
export function demoSql(installId: string, count: number, now?: number): string {
  checkInstallId(installId);
  const meetings = demoMeetings(count, now);
  const owners = DEV_USERS.map((u) => quote(u.id)).join(', ');
  const iid = quote(installId);
  let sql = `DELETE FROM meetings WHERE install_id = ${iid} AND owner_id IN (${owners});\n`;

  sql += insertRows(
    'meetings',
    ['id', 'install_id', 'owner_id', 'title', 'title_folded', 'started_at', 'visibility', 'keep'],
    meetings.map((m) => [
      quote(m.id),
      iid,
      quote(m.ownerId),
      quote(m.title),
      quote(foldTitle(m.title)),
      String(m.startedAt),
      quote(m.visibility),
      m.keep ? '1' : '0',
    ]),
  );

  const recordings = meetings.filter((m) => m.recording);
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
      'failure',
      'created_at',
      'confirmed_at',
    ],
    recordings.map((m) => {
      const r = m.recording!;
      const id = `${m.id}-r1`;
      const done = m.startedAt + r.durationS * 1000;
      return [
        quote(id),
        iid,
        quote(m.id),
        quote(m.ownerId),
        quote('upload'),
        '1',
        String(r.durationS),
        quote('0'.repeat(64)),
        String(r.durationS * 4000),
        quote('audio/webm'),
        // No object behind it: the demo library has no audio.
        quote(`recordings/${installId}/${m.id}/${id}.webm`),
        quote(r.status),
        r.failure ? quote(r.failure) : 'NULL',
        String(done),
        String(done),
      ];
    }),
  );

  const shares = meetings.flatMap((m) => m.sharedWith.map((userId) => [m.id, userId] as const));
  if (shares.length) {
    sql += insertRows(
      'meeting_shares',
      ['install_id', 'meeting_id', 'user_id'],
      shares.map(([meetingId, userId]) => [iid, quote(meetingId), quote(userId)]),
    );
  }
  sql += foreignInstallSql(installId);
  return sql;
}
