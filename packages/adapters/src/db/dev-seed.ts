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
import { accessDemoSql } from './dev-seed-access.ts';

/**
 * The users the demo library belongs to. Their subjects are the ones the e2e
 * build's test sign-in writes (`test|<email>`, lib/auth/test-sign-in.ts), so
 * signing in as one of them lands on the seeded row. Names are invented.
 */
const user = (id: string, email: string, name: string, isAdmin: boolean) =>
  ({ id, subject: `test|${email}`, email, name, isAdmin }) as const;
export const DEV_USERS = [
  user('dev-user', 'mette.lund@example.com', 'Mette Lund', true),
  user('dev-colleague', 'jonas.skov@example.com', 'Jonas Skov', false),
  user('dev-newcomer', 'anne.holm@example.com', 'Anne Holm', false),
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
  // Transcripts (demoTranscriptsSql): figure 04's meeting, a 4-hour day with 14 speakers,
  // a transcript with no speakers and one with no speech.
  if (meetings[0])
    meetings[0].recording = { status: 'transcribed', durationS: 2526, failure: null };
  if (meetings[4]) {
    meetings[4].title = 'Telefonmøde uden talere';
    meetings[4].recording = { status: 'transcribed', durationS: 600, failure: null };
  }
  if (meetings[5]) {
    meetings[5].title = 'Optagelse uden tale';
    meetings[5].recording = { status: 'transcribed', durationS: 120, failure: null };
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

/**
 * A meeting of the colleague with something in every table that hangs off a
 * meeting, for the delete test: a transcript with a speaker and three
 * segments, a recap with a version and a decision, a share and an audit row.
 */
function graphSql(installId: string): string {
  const i = quote(installId);
  const t = Date.UTC(2026, 9, 1, 9);
  return (
    [
      // Audit rows outlive their meeting (meeting_id set null), so a reseed clears this one by id.
      `DELETE FROM audit_events WHERE id = 'demo-graph-a1';`,
      `INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES ('demo-graph', ${i}, 'dev-colleague', 'Møde med alt i', 'møde med alt i', ${t}, 'shared');`,
      `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at) VALUES ('demo-graph-r1', ${i}, 'demo-graph', 'dev-colleague', 'upload', 1, 60, '${'0'.repeat(64)}', 1, 'audio/webm', 'recordings/${installId}/demo-graph/demo-graph-r1.webm', 'transcribed', ${t}, ${t});`,
      `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json) VALUES ('demo-graph-t1', ${i}, 'demo-graph-r1', 'demo', 'demo', 'da', '{}');`,
      `INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('demo-graph-s1', ${i}, 'demo-graph', 'Speaker 1');`,
      `INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES ('demo-graph-g1', ${i}, 'demo-graph-t1', 'demo-graph-s1', 0, 1000, 'a'), ('demo-graph-g2', ${i}, 'demo-graph-t1', 'demo-graph-s1', 1000, 2000, 'b'), ('demo-graph-g3', ${i}, 'demo-graph-t1', 'demo-graph-s1', 2000, 3000, 'c');`,
      `INSERT INTO recaps (id, install_id, meeting_id, body_md) VALUES ('demo-graph-c1', ${i}, 'demo-graph', '# Referat');`,
      `INSERT INTO recap_versions (id, install_id, recap_id, body_md) VALUES ('demo-graph-v1', ${i}, 'demo-graph-c1', '# Referat');`,
      `UPDATE recaps SET current_version_id = 'demo-graph-v1' WHERE id = 'demo-graph-c1';`,
      `INSERT INTO decisions (id, install_id, recap_id, text) VALUES ('demo-graph-d1', ${i}, 'demo-graph-c1', 'Beslutning');`,
      `INSERT INTO meeting_shares (install_id, meeting_id, user_id) VALUES (${i}, 'demo-graph', 'dev-user');`,
      `INSERT INTO audit_events (id, install_id, user_id, meeting_id, meeting_title, action) VALUES ('demo-graph-a1', ${i}, 'dev-user', 'demo-graph', 'Møde med alt i', 'opened');`,
    ].join('\n') + '\n'
  );
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
  sql += graphSql(installId);
  sql += foreignInstallSql(installId);
  if (count > 5) sql += demoTranscriptsSql(installId);
  sql += accessDemoSql(installId, meetings, now ?? Date.UTC(2026, 9, 22, 9, 0));
  if (count > 5) sql += demoRecapsSql(installId);
  return sql;
}

/** Figure 04's recap: the AI's draft (v1), then three saves by the dev user. */
const FIGURE_04_RECAP = `# En rolig opstart på linje 2

> [!NOTE]
> Vi øger først kapaciteten, når torsdagens test er godkendt.

## Beslutninger

<!-- decisions -->
- [ ] Test det nye skift torsdag. [@Jonas Skov](mtxt:user/dev-colleague)
- [x] Saml kapacitetstallene. [@Anne Holm](mtxt:user/dev-newcomer)
<!-- /decisions -->

## Næste skridt

| Opgave | Ansvarlig | Frist |
| --- | --- | --- |
| Skiftetest | Jonas | 22. okt. |
| Opdatér planen | Anne | 23. okt. |

<details>
<summary>Åbne spørgsmål til næste møde</summary>

Kan det nye skift dække fredagens ekstra ordre?

</details>
`;
const FIGURE_04_TEXT = [
  'En rolig opstart på linje 2',
  'Vi øger først kapaciteten, når torsdagens test er godkendt.',
  'Beslutninger',
  'Test det nye skift torsdag. @Jonas Skov',
  'Saml kapacitetstallene. @Anne Holm',
  'Næste skridt',
  'Opgave Ansvarlig Frist Skiftetest Jonas 22. okt. Opdatér planen Anne 23. okt.',
  'Åbne spørgsmål til næste møde',
  'Kan det nye skift dække fredagens ekstra ordre?',
].join('\n');

const RECAP_WORDS = [
  'kapaciteten',
  'leverancen',
  'kvaliteten',
  'budgettet',
  'lageret',
  'kunden',
  'tidsplanen',
  'produktionen',
  'vedligeholdet',
  'indkøbet',
  'rapporten',
  'sikkerheden',
  'oplæringen',
  'maskinen',
  'leveringen',
  'kontrakten',
  'prisen',
  'analysen',
  'skiftet',
  'ordren',
];
const RECAP_VERBS = ['gennemgår', 'følger op på', 'tester', 'justerer', 'beskriver', 'måler'];

/**
 * A recap of about 3,000 words with 40 decisions under a 120-character
 * heading (behaviour.md rule 13), on demo-0001, whose title is that heading.
 */
function longRecap(): { md: string; text: string } {
  const random = generator(43);
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const sentence = () => {
    const words = [
      pick(RECAP_WORDS),
      pick(RECAP_VERBS),
      pick(RECAP_WORDS),
      'inden',
      pick(['fredag', 'mandag', 'næste uge', 'kvartalets udgang']),
    ];
    const s = `Holdet ${words.slice(1, 3).join(' ')} ${words[0]} og ${words[2]} ${words.slice(3).join(' ')}, så alle kan se status.`;
    return s;
  };
  const md: string[] = [`# ${LONG_TITLE}`, '', '<!-- toc -->', ''];
  const text: string[] = [LONG_TITLE];
  let words = 0;
  for (let section = 1; words < 2600; section++) {
    md.push(`## Punkt ${section}: ${pick(RECAP_WORDS)}`, '');
    text.push(`Punkt ${section}`);
    for (let p = 0; p < 4; p++) {
      const para = Array.from({ length: 6 }, sentence).join(' ');
      words += para.split(' ').length;
      md.push(para, '');
      text.push(para);
    }
  }
  md.push('## Beslutninger', '', '<!-- decisions -->');
  const owners = [
    ['dev-user', 'Mette Lund'],
    ['dev-colleague', 'Jonas Skov'],
    ['dev-newcomer', 'Anne Holm'],
  ] as const;
  for (let i = 0; i < 40; i++) {
    const [id, name] = owners[i % 3]!;
    const item = `Beslutning ${i + 1}: ${pick(RECAP_VERBS)} ${pick(RECAP_WORDS)} inden ${pick(['fredag', 'mandag'])}.`;
    md.push(`- [${i % 4 === 0 ? 'x' : ' '}] ${item} [@${name}](mtxt:user/${id})`);
    text.push(`${item} @${name}`);
  }
  md.push('<!-- /decisions -->', '');
  return { md: md.join('\n'), text: text.join('\n') };
}

/** The demo recaps: figure 04's on demo-0000, the long one on demo-0001, with their rows and search text. */
export function demoRecapsSql(installId: string): string {
  const iid = quote(installId);
  const t = Date.UTC(2026, 9, 22, 10);
  const long = longRecap();
  let sql = '';
  const recap = (
    id: string,
    meetingId: string,
    versions: { author: string | null; md: string }[],
    text: string,
  ) => {
    sql += `INSERT INTO recaps (id, install_id, meeting_id, body_md, status) VALUES (${quote(id)}, ${iid}, ${quote(meetingId)}, ${quote(versions.at(-1)!.md)}, 'ready');\n`;
    sql += insertRows(
      'recap_versions',
      ['id', 'install_id', 'recap_id', 'number', 'author_id', 'body_md', 'note', 'created_at'],
      versions.map((v, n) => [
        quote(`${id}-v${n + 1}`),
        iid,
        quote(id),
        String(n + 1),
        v.author ? quote(v.author) : 'NULL',
        quote(v.md),
        'NULL',
        String(t + n * 600_000),
      ]),
    );
    sql += `UPDATE recaps SET current_version_id = ${quote(`${id}-v${versions.length}`)} WHERE id = ${quote(id)};\n`;
    sql += `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES (${iid}, ${quote(meetingId)}, 'm' || lower(hex(${quote(meetingId)})), 'recap', ${quote(id)}, ${quote(text)});\n`;
  };
  const draft = FIGURE_04_RECAP.replace('- [x] Saml', '- [ ] Saml').replace(
    '| Opdatér planen | Anne | 23. okt. |\n',
    '',
  );
  recap(
    'demo-0000-recap',
    'demo-0000',
    [
      { author: null, md: draft },
      { author: 'dev-user', md: draft.replace('Vi øger først', 'Vi øger') },
      { author: 'dev-user', md: draft },
      { author: 'dev-user', md: FIGURE_04_RECAP },
    ],
    FIGURE_04_TEXT,
  );
  sql += insertRows(
    'decisions',
    ['id', 'install_id', 'recap_id', 'position', 'text', 'owner_user_id', 'done'],
    [
      [
        "'demo-0000-d1'",
        iid,
        "'demo-0000-recap'",
        '0',
        quote('Test det nye skift torsdag. @Jonas Skov'),
        "'dev-colleague'",
        '0',
      ],
      [
        "'demo-0000-d2'",
        iid,
        "'demo-0000-recap'",
        '1',
        quote('Saml kapacitetstallene. @Anne Holm'),
        "'dev-newcomer'",
        '1',
      ],
    ],
  );
  recap('demo-0001-recap', 'demo-0001', [{ author: null, md: long.md }], long.text);
  const rows = long.md
    .split('\n')
    .filter((l) => /^- \[[ x]\] Beslutning/.test(l))
    .map((l, i) => {
      const done = l.startsWith('- [x]');
      const name = /\[@([^\]]+)\]/.exec(l)![1]!;
      const owner = /mtxt:user\/([a-z-]+)/.exec(l)![1]!;
      const item = l.replace(/^- \[[ x]\] /, '').replace(/ \[@[^\]]+\]\([^)]+\)$/, '');
      return [
        quote(`demo-0001-d${i + 1}`),
        iid,
        "'demo-0001-recap'",
        String(i),
        quote(`${item} @${name}`),
        quote(owner),
        done ? '1' : '0',
      ];
    });
  sql += insertRows(
    'decisions',
    ['id', 'install_id', 'recap_id', 'position', 'text', 'owner_user_id', 'done'],
    rows,
  );
  return sql;
}

/** Figure 04's lines, then more of the same meeting until 42 minutes are filled. */
const FIGURE_04 = [
  [
    0,
    'Så er vi samlet. Lad os begynde med kapaciteten på linje 2. Jonas, hvor står vi med testen?',
  ],
  [
    1,
    'Vi nåede de 240 enheder i går. Vi mangler stadig at teste det nye skift, før vi ændrer planen.',
  ],
  [2, 'Jeg tager testen torsdag. Hvis kvaliteten holder, kan vi sætte det i drift fra mandag.'],
  [
    0,
    'Godt. Så aftaler vi, at Søren melder tilbage fredag. Anne, vil du samle tallene i ugeplanen?',
  ],
  [3, 'Ja. Jeg opdaterer planen, så alle kan se kapaciteten inden fredag klokken tolv.'],
] as const;
const PHRASES = [
  'Lageret melder, at materialerne til næste uge er bestilt',
  'Vi skal have kvaliteten på plads, før vi øger tempoet',
  'Kunden i Århus har spurgt til leveringen i november',
  'Jeg foreslår, at vi tager det op på mødet om økonomi',
  'Det nye skift kører med to mand færre end det gamle',
  'Er der nogen, der har set tallene fra Ærø-afdelingen',
  'Vi har haft tre stop på linje 2 siden mandag',
  'Planen er sendt rundt, og ugeplanen er opdateret',
];

interface SeedSegment {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

function transcriptRows(
  installId: string,
  key: string,
  recordingId: string,
  meetingId: string,
  speakers: { label: string; userId: string | null }[],
  segments: SeedSegment[],
): string {
  const i = quote(installId);
  const tid = `${key}-t`;
  let sql = `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status) VALUES (${quote(tid)}, ${i}, ${quote(recordingId)}, 'assemblyai', 'universal-3-5-pro', 'da', '{}', 'done');\n`;
  if (speakers.length) {
    sql += insertRows(
      'speakers',
      ['id', 'install_id', 'meeting_id', 'label', 'user_id', 'speaker_index'],
      speakers.map((sp, n) => [
        quote(`${key}-s${n}`),
        i,
        quote(meetingId),
        quote(sp.label),
        sp.userId ? quote(sp.userId) : 'NULL',
        String(n),
      ]),
    );
  }
  if (segments.length) {
    sql += insertRows(
      'segments',
      ['id', 'install_id', 'transcript_id', 'speaker_id', 'start_ms', 'end_ms', 'text'],
      segments.map((g, n) => [
        quote(`${key}-g${n}`),
        i,
        quote(tid),
        g.speaker === null ? 'NULL' : quote(`${key}-s${g.speaker}`),
        String(g.start),
        String(g.end),
        quote(g.text),
      ]),
    );
  }
  return sql;
}

/** Sentences from PHRASES, deterministic, until `until` ms, rotating through `speakers`. */
function fill(from: number, until: number, speakers: number, seed: number, every = 2400) {
  const random = generator(seed);
  const out: SeedSegment[] = [];
  for (let at = from, n = 0; at < until; n++) {
    const length = every + Math.floor(random() * every);
    const words = 1 + Math.floor(random() * 2);
    const text = Array.from(
      { length: words },
      () => PHRASES[Math.floor(random() * PHRASES.length)]!,
    )
      .join('. ')
      .concat('.');
    out.push({
      speaker: speakers ? Math.floor(random() * speakers) : null,
      start: at,
      end: Math.min(until, at + length - 300),
      text,
    });
    at += length;
  }
  return out;
}

/**
 * Transcripts for the demo library (behaviour.md rule 13): demo-0000 is
 * figure 04 (four speakers, three linked to the dev users, Speaker 3 not),
 * demo-0002 is a 4-hour day of 6,000 segments and 14 speakers, demo-0004
 * has segments with no speaker, demo-0005 was transcribed and has no speech.
 */
export function demoTranscriptsSql(installId: string): string {
  const [dev, colleague, newcomer] = DEV_USERS;
  let sql = '';
  const figure: SeedSegment[] = FIGURE_04.map(([speaker, text], n) => ({
    speaker,
    start: [0, 18000, 36000, 49000, 63000][n]!,
    end: [17400, 35200, 48100, 62300, 71800][n]!,
    text,
  }));
  sql += transcriptRows(
    installId,
    'demo-0000',
    'demo-0000-r1',
    'demo-0000',
    [
      { label: 'Mette Lund', userId: dev.id },
      { label: 'Jonas Skov', userId: colleague.id },
      { label: 'Speaker 3', userId: null },
      { label: 'Anne Holm', userId: newcomer.id },
    ],
    [...figure, ...fill(73000, 2526_000, 4, 4, 9000)],
  );
  sql += transcriptRows(
    installId,
    'demo-0002',
    'demo-0002-r1',
    'demo-0002',
    Array.from({ length: 14 }, (_, n) =>
      n === 0
        ? { label: 'Mette Lund', userId: dev.id }
        : { label: `Speaker ${n + 1}`, userId: null },
    ),
    // 4 hours over 6,000 segments: 2.4 s each.
    Array.from({ length: 6000 }, (_, n) => ({
      speaker: (n * 5) % 14,
      start: n * 2400,
      end: n * 2400 + 2200,
      text: `${PHRASES[n % PHRASES.length]!}, punkt ${n + 1}.`,
    })),
  );
  sql += transcriptRows(
    installId,
    'demo-0004',
    'demo-0004-r1',
    'demo-0004',
    [],
    fill(0, 600_000, 0, 9),
  );
  sql += transcriptRows(installId, 'demo-0005', 'demo-0005-r1', 'demo-0005', [], []);
  return sql;
}
