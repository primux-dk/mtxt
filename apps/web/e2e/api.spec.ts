import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './contract';
import {
  ADMIN,
  d1,
  DESKTOP,
  expectFocusRing,
  openUserMenu,
  PHONE,
  settle,
  shot,
  signIn,
  tabTo,
} from './helpers';

/*
  Packet 16: personal API tokens and the REST API (docs/spec.md "API").
  A user makes tokens in the API tokens dialog, then a script calls
  /api/v1 with them as a company's system would. Every /api/v1 response is
  checked against the contract (e2e/contract.ts). The spec's own users and
  meetings keep the seeded library as the other specs expect it.
*/
const IDA = { email: 'ida.brandt@example.com', name: 'Ida Brandt', admin: false };
const OLE = { email: 'ole.dahl@example.com', name: 'Ole Dahl', admin: false };
/** Rule 13: the longest name the dialog takes. */
const LONG_NAME = 'Sagsbehandlingssystemet på Æblehaven, integration til Østjylland';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const userId = (email: string) =>
  d1<{ id: string }>(`select id from users where email = '${email}'`)[0]!.id;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Ida's meetings and Ole's private one, written straight to the local D1 with their children. */
function fixtures(ida: string, ole: string) {
  const at = Date.UTC(2026, 9, 20, 9);
  const m = (id: string, owner: string, title: string, visibility: string, t: number) =>
    `INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES (${q(id)}, 'dev', ${q(owner)}, ${q(title)}, ${q(title.toLocaleLowerCase('da'))}, ${t}, ${q(visibility)});`;
  const body = [
    '# Referat',
    '',
    'Vi aftalte færgeplanen til Ærø.',
    '',
    '<!-- decisions -->',
    `- [ ] Bestil billetter [@Ole Dahl](mtxt:user/${ole})`,
    '- [x] Send budget',
    '<!-- /decisions -->',
    '',
  ].join('\n');
  d1(
    [
      m('api-ida-1', ida, 'API-møde om færgen til Ærø', 'private', at),
      m('api-ida-2', ida, 'API-møde, budget', 'private', at - 86_400_000),
      m('api-ole-1', ole, 'Oles hemmelige møde om Ærø', 'private', at + 3_600_000),
      `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at) VALUES ('api-ida-1-r', 'dev', 'api-ida-1', ${q(ida)}, 'upload', 1, 95, '${'0'.repeat(64)}', 1, 'audio/webm', 'recordings/dev/api-ida-1/api-ida-1-r.webm', 'transcribed', ${at}, ${at});`,
      `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status) VALUES ('api-ida-1-t', 'dev', 'api-ida-1-r', 'assemblyai', 'universal-3-5-pro', 'da', '{}', 'done');`,
      `INSERT INTO speakers (id, install_id, meeting_id, label, user_id, speaker_index) VALUES ('api-ida-1-s0', 'dev', 'api-ida-1', 'Ida Brandt', ${q(ida)}, 0), ('api-ida-1-s1', 'dev', 'api-ida-1', 'Speaker 2', NULL, 1);`,
      `INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES
        ('api-ida-1-g0', 'dev', 'api-ida-1-t', 'api-ida-1-s0', 0, 4000, 'Godmorgen, vi skal tale om færgen til Ærø.'),
        ('api-ida-1-g1', 'dev', 'api-ida-1-t', 'api-ida-1-s1', 65000, 69000, 'Billetterne er bestilt.'),
        ('api-ida-1-g2', 'dev', 'api-ida-1-t', NULL, 3725000, 3726000, 'Tak for i dag.');`,
      `INSERT INTO recaps (id, install_id, meeting_id, body_md, status) VALUES ('api-ida-1-c', 'dev', 'api-ida-1', ${q(body)}, 'ready');`,
      `INSERT INTO recap_versions (id, install_id, recap_id, number, author_id, body_md, created_at) VALUES ('api-ida-1-v1', 'dev', 'api-ida-1-c', 1, NULL, ${q(body)}, ${at});`,
      `UPDATE recaps SET current_version_id = 'api-ida-1-v1' WHERE id = 'api-ida-1-c';`,
      `INSERT INTO decisions (id, install_id, recap_id, position, text, owner_user_id, done) VALUES ('api-ida-1-d0', 'dev', 'api-ida-1-c', 0, 'Bestil billetter', ${q(ole)}, 0), ('api-ida-1-d1', 'dev', 'api-ida-1-c', 1, 'Send budget', NULL, 1);`,
      ...['api-ida-1', 'api-ida-2', 'api-ole-1'].map(
        (id) =>
          `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) SELECT 'dev', id, 'm' || lower(hex(id)), 'title', id, title FROM meetings WHERE id = ${q(id)};`,
      ),
      `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES ('dev', 'api-ida-1', 'm' || lower(hex('api-ida-1')), 'segment', 'api-ida-1-g1', 'Billetterne er bestilt.');`,
      `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES ('dev', 'api-ole-1', 'm' || lower(hex('api-ole-1')), 'segment', 'api-ole-1', 'Billetterne er hemmelige.');`,
    ].join('\n'),
  );
}

async function openApiTokens(page: Page) {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitem', { name: 'API tokens' }).click();
  return page.getByRole('dialog', { name: /API token|Copy your token now/ });
}

/** Makes a token in the dialog and answers the token it showed once. */
async function makeToken(page: Page, name: string, scope: 'Read only' | 'Read and write') {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'New token' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByRole('radio', { name: new RegExp(`^${scope}`) }).check();
  await dialog.getByRole('button', { name: 'Create token' }).click();
  const value = dialog.getByLabel('Token', { exact: true });
  await expect(value).toBeFocused();
  const token = await value.inputValue();
  expect(token).toMatch(/^mtxt_[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.getByTestId('api-tokens-list').getByText(name)).toBeVisible();
  return token;
}

/** Every page of GET /meetings, through the cursor. */
async function allMeetings(request: APIRequestContext, token: string, query = '') {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request.get(
      `/api/v1/meetings?limit=100${query}${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: bearer(token) },
    );
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      meetings: { id: string }[];
      next_cursor: string | null;
    };
    ids.push(...body.meetings.map((m) => m.id));
    cursor = body.next_cursor;
  } while (cursor);
  return ids;
}

test.describe.configure({ mode: 'serial' });

let readToken = '';
let writeToken = '';
let oleToken = '';
let ida = '';
let ole = '';

test('make a token in the dialog: the field says what is wrong, the token shows once, Copy copies it', async ({
  page,
  context,
}) => {
  await signIn(context.request, OLE);
  await signIn(context.request, IDA);
  ida = userId(IDA.email);
  ole = userId(OLE.email);
  fixtures(ida, ole);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  const dialog = await openApiTokens(page);
  await expect(dialog.getByText('No API tokens')).toBeVisible();

  // Rule 9: the error at the field, what was typed kept.
  await dialog.getByRole('button', { name: 'New token' }).click();
  await expect(dialog.getByRole('heading', { name: 'New API token' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Create token' }).click();
  await expect(dialog.getByText('Give the token a name.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('x'.repeat(65));
  await dialog.getByRole('button', { name: 'Create token' }).click();
  await expect(dialog.getByText('The name is at most 64 characters. Shorten it.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'x'.repeat(65),
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  readToken = await makeToken(page, 'Alex læser', 'Read only');
  // Shown once: the list never shows it again, and the row keeps only its hash.
  await expect(dialog.getByText(readToken)).toHaveCount(0);
  const [row] = d1<{ token_hash: string; kind: string; scope: string }>(
    `select token_hash, kind, scope from recorder_tokens where device_name = 'Alex læser'`,
  );
  expect(row).toEqual({
    token_hash: createHash('sha256').update(readToken).digest('hex'),
    kind: 'api',
    scope: 'read',
  });

  // Copy puts the token on the clipboard.
  await dialog.getByRole('button', { name: 'New token' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Alex skriver');
  await dialog.getByRole('radio', { name: /^Read and write/ }).check();
  await dialog.getByLabel('Expires after').selectOption('90');
  await dialog.getByRole('button', { name: 'Create token' }).click();
  writeToken = await dialog.getByLabel('Token', { exact: true }).inputValue();
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(writeToken);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.getByRole('heading', { name: '2 tokens' })).toBeVisible();
  await expect(dialog.getByTestId('api-tokens-list').getByText('Read and write')).toBeVisible();
  const [expiry] = d1<{ days: number }>(
    `select round((expires_at - created_at) / 86400000.0) as days from recorder_tokens where device_name = 'Alex skriver'`,
  );
  expect(expiry!.days).toBe(90);
  // Never logged.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Ole's own read token, for the reader's side.
  await signIn(context.request, OLE);
  await page.goto('/meetings');
  await openApiTokens(page);
  oleToken = await makeToken(page, 'Oles script', 'Read only');
});

test("the list holds what the token's user may read: other people's private meetings are absent", async ({
  request,
}) => {
  const ids = await allMeetings(request, readToken);
  expect(ids).toContain('api-ida-1');
  expect(ids).toContain('api-ida-2');
  expect(ids).not.toContain('api-ole-1');
  const othersPrivate = d1<{ id: string }>(
    `select id from meetings where install_id = 'dev' and visibility = 'private' and owner_id != '${ida}'`,
  ).map((r) => r.id);
  expect(othersPrivate.length).toBeGreaterThan(0);
  expect(ids.filter((id) => othersPrivate.includes(id))).toEqual([]);
  // Company meetings are there; nobody's private ones but Ida's own.
  const company = d1<{ n: number }>(
    `select count(*) as n from meetings where install_id = 'dev' and visibility = 'company' and deleted_at is null`,
  )[0]!.n;
  expect(ids).toHaveLength(company + 2);

  // A small page pages through with the cursor to the same list.
  const paged: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request.get(
      `/api/v1/meetings?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: bearer(readToken) },
    );
    const body = (await response.json()) as { meetings: { id: string }[]; next_cursor: string };
    paged.push(...body.meetings.map((m) => m.id));
    cursor = body.next_cursor;
  } while (cursor);
  expect(paged).toEqual(ids);

  // Filters: mine, a search, a start.
  expect(await allMeetings(request, readToken, '&view=mine')).toEqual(['api-ida-1', 'api-ida-2']);
  expect(await allMeetings(request, readToken, '&view=mine&q=%C3%A6r%C3%B8')).toEqual([
    'api-ida-1',
  ]);
  expect(await allMeetings(request, readToken, '&view=mine&since=2026-10-20')).toEqual([
    'api-ida-1',
  ]);
  const bad = await request.get('/api/v1/meetings?page=2', { headers: bearer(readToken) });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error.message).toBe('Unknown parameter "page".');
  for (const since of ['2026-02-31', '2026-02-30T00:00:00Z']) {
    const day = await request.get(`/api/v1/meetings?since=${since}`, {
      headers: bearer(readToken),
    });
    expect(day.status(), since).toBe(400);
  }
});

test('a meeting, its transcript and its recap in every format; ETag and 304; search', async ({
  request,
}) => {
  const detail = await request.get('/api/v1/meetings/api-ida-1', { headers: bearer(readToken) });
  expect(detail.status()).toBe(200);
  expect(await detail.json()).toMatchObject({
    id: 'api-ida-1',
    title: 'API-møde om færgen til Ærø',
    access: 'owner',
    state: 'ready',
    has_transcript: true,
    has_recap: true,
    transcript: { status: 'done', language: 'da' },
    recap: { status: 'ready', version: { id: 'api-ida-1-v1', number: 1, author: null } },
    shares: [],
  });
  const etag = detail.headers()['etag']!;
  expect(detail.headers()['x-ratelimit-limit']).toBe('60');
  const again = await request.get('/api/v1/meetings/api-ida-1', {
    headers: { ...bearer(readToken), 'if-none-match': etag },
  });
  expect(again.status()).toBe(304);
  expect(again.headers()['etag']).toBe(etag);

  const json = await request.get('/api/v1/meetings/api-ida-1/transcript', {
    headers: bearer(readToken),
  });
  expect(await json.json()).toMatchObject({
    language: 'da',
    speakers: [
      { id: 'api-ida-1-s0', name: 'Ida Brandt' },
      { id: 'api-ida-1-s1', name: 'Speaker 2' },
    ],
    segments: [
      {
        start_ms: 0,
        speaker_id: 'api-ida-1-s0',
        text: 'Godmorgen, vi skal tale om færgen til Ærø.',
      },
      { start_ms: 65000, speaker_id: 'api-ida-1-s1' },
      { start_ms: 3725000, speaker_id: null },
    ],
  });
  const text = await request.get('/api/v1/meetings/api-ida-1/transcript?format=text', {
    headers: bearer(readToken),
  });
  expect(text.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(await text.text()).toBe(
    '[0:00:00] Ida Brandt: Godmorgen, vi skal tale om færgen til Ærø.\n' +
      '[0:01:05] Speaker 2: Billetterne er bestilt.\n' +
      '[1:02:05] Tak for i dag.\n',
  );

  const recap = await request.get('/api/v1/meetings/api-ida-1/recap', {
    headers: bearer(readToken),
  });
  expect(await recap.json()).toMatchObject({
    status: 'ready',
    version: { id: 'api-ida-1-v1', number: 1, author: null },
    body_md: expect.stringContaining('færgeplanen til Ærø'),
    decisions: [
      { position: 0, text: 'Bestil billetter', done: false, owner: { id: ole, name: OLE.name } },
      { position: 1, text: 'Send budget', done: true, owner: null },
    ],
  });
  const markdown = await request.get('/api/v1/meetings/api-ida-1/recap?format=markdown', {
    headers: bearer(readToken),
  });
  expect(markdown.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(await markdown.text()).toContain('# Referat');
  const docx = await request.get('/api/v1/meetings/api-ida-1/recap?format=docx', {
    headers: bearer(readToken),
  });
  expect(docx.status()).toBe(200);
  const zip = await JSZip.loadAsync(await docx.body());
  expect(await zip.file('word/document.xml')!.async('string')).toContain('færgeplanen til Ærø');
  // A Word file is built anew each time, to the same bytes: two plain downloads match, and so do their ETags.
  const docxTwice = await request.get('/api/v1/meetings/api-ida-1/recap?format=docx', {
    headers: bearer(readToken),
  });
  expect(Buffer.from(await docxTwice.body()).equals(Buffer.from(await docx.body()))).toBe(true);
  expect(docxTwice.headers()['etag']).toBe(docx.headers()['etag']);
  const docxAgain = await request.get('/api/v1/meetings/api-ida-1/recap?format=docx', {
    headers: { ...bearer(readToken), 'if-none-match': docx.headers()['etag']! },
  });
  expect(docxAgain.status()).toBe(304);
  const wrong = await request.get('/api/v1/meetings/api-ida-1/recap?format=pdf', {
    headers: bearer(readToken),
  });
  expect(wrong.status()).toBe(400);
  const none = await request.get('/api/v1/meetings/api-ida-2/transcript', {
    headers: bearer(readToken),
  });
  expect(none.status()).toBe(404);

  const search = await request.get('/api/v1/search?q=billetterne', {
    headers: bearer(readToken),
  });
  const found = (await search.json()) as {
    results: {
      meeting: { id: string };
      match: string;
      snippet: { text: string; hit: boolean }[];
      start_s: number;
    }[];
  };
  expect(found.results.map((r) => r.meeting.id)).toEqual(['api-ida-1']);
  expect(found.results[0]).toMatchObject({ match: 'transcript', start_s: 65 });
  expect(found.results[0]!.snippet).toContainEqual({ text: 'Billetterne', hit: true });
  // Another user's meeting is not found, and neither is a meeting that is not readable.
  const others = await request.get('/api/v1/meetings/api-ole-1', { headers: bearer(readToken) });
  expect(others.status()).toBe(404);
});

test('a read-only token cannot write; a read_write token sets title, visibility, keep and readers', async ({
  request,
}) => {
  const refused = await request.patch('/api/v1/meetings/api-ida-2', {
    headers: bearer(readToken),
    data: { title: 'Nej' },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe('insufficient_scope');
  const refusedSave = await request.put('/api/v1/meetings/api-ida-1/recap', {
    headers: bearer(readToken),
    data: { base_version_id: 'api-ida-1-v1', body_md: '# Nej' },
  });
  expect(refusedSave.status()).toBe(403);

  const patched = await request.patch('/api/v1/meetings/api-ida-2', {
    headers: bearer(writeToken),
    data: { title: '  API-møde, budget 2027 ', visibility: 'shared', keep: true },
  });
  expect(patched.status()).toBe(200);
  expect(await patched.json()).toMatchObject({
    title: 'API-møde, budget 2027',
    visibility: 'shared',
    keep: true,
    shares: [],
  });
  // A reader by address; a second add changes nothing.
  for (let i = 0; i < 2; i++) {
    const shared = await request.post('/api/v1/meetings/api-ida-2/shares', {
      headers: bearer(writeToken),
      data: { email: OLE.email.toUpperCase() },
    });
    expect(shared.status()).toBe(200);
    expect(await shared.json()).toEqual({
      shares: [{ id: ole, name: OLE.name, email: OLE.email }],
    });
  }
  // Ole now reads it, and only reads it.
  const asOle = await request.get('/api/v1/meetings/api-ida-2', { headers: bearer(oleToken) });
  expect(asOle.status()).toBe(200);
  expect(await asOle.json()).toMatchObject({ access: 'reader', shares: null });
  const removed = await request.delete(`/api/v1/meetings/api-ida-2/shares/${ole}`, {
    headers: bearer(writeToken),
  });
  expect(removed.status()).toBe(204);
  expect(
    (await request.get('/api/v1/meetings/api-ida-2', { headers: bearer(oleToken) })).status(),
  ).toBe(404);
  const notShared = await request.post('/api/v1/meetings/api-ida-1/shares', {
    headers: bearer(writeToken),
    data: { user_id: ole },
  });
  expect(notShared.status()).toBe(400);
  // Someone who is not a user of this install, unknown or another install's, is one 404.
  const stranger = await request.post('/api/v1/meetings/api-ida-2/shares', {
    headers: bearer(writeToken),
    data: { email: 'nobody@example.com' },
  });
  expect(stranger.status()).toBe(404);
  expect((await stranger.json()).error.code).toBe('not_found');

  // The recap: a save on the version read, then a stale one is a conflict naming the current.
  const save = await request.put('/api/v1/meetings/api-ida-1/recap', {
    headers: bearer(writeToken),
    data: { base_version_id: 'api-ida-1-v1', body_md: '# Referat\n\nGemt af Alex.\n' },
  });
  expect(save.status()).toBe(200);
  const saved = (await save.json()) as { version: { id: string; number: number; author: unknown } };
  expect(saved.version).toMatchObject({ number: 2, author: { id: ida, name: IDA.name } });
  const stale = await request.put('/api/v1/meetings/api-ida-1/recap', {
    headers: bearer(writeToken),
    data: { base_version_id: 'api-ida-1-v1', body_md: '# Gammel' },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: { code: 'conflict' },
    current: { id: saved.version.id, number: 2 },
  });

  // Back to private, so the seeded library stays as the other specs expect it.
  const back = await request.patch('/api/v1/meetings/api-ida-2', {
    headers: bearer(writeToken),
    data: { visibility: 'private', keep: false },
  });
  expect(back.status()).toBe(200);
});

test("a token of one kind is refused on the other's paths", async ({ request }) => {
  const recorder = `mtxt_${randomBytes(32).toString('base64url')}`;
  d1(
    `insert into recorder_tokens (id, install_id, user_id, device_name, token_hash, created_at, expires_at) values ('api-spec-rec', 'dev', '${ida}', 'Idas Mac', '${createHash('sha256').update(recorder).digest('hex')}', ${Date.now()}, ${Date.now() + 86_400_000})`,
  );
  const onApi = await request.get('/api/v1/meetings', { headers: bearer(recorder) });
  expect(onApi.status()).toBe(403);
  expect((await onApi.json()).error.code).toBe('forbidden');
  const onRecorder = await request.get('/api/v1/recordings/api-ida-1-r', {
    headers: bearer(readToken),
  });
  expect(onRecorder.status()).toBe(403);
  const noToken = await request.get('/api/v1/meetings', {
    headers: { authorization: 'Bearer nope' },
  });
  expect(noToken.status()).toBe(401);
});

test('the 61st request in a minute is 429 with Retry-After', async ({ page, context, request }) => {
  await signIn(context.request, IDA);
  await page.goto('/meetings');
  await openApiTokens(page);
  const token = await makeToken(page, 'Alex travl', 'Read only');
  for (let i = 0; i < 60; i++) {
    const ok = await request.get('/api/v1/meetings?view=mine', { headers: bearer(token) });
    expect(ok.status(), `request ${i + 1}`).toBe(200);
    expect(ok.headers()['x-ratelimit-remaining']).toBe(String(59 - i));
  }
  const limited = await request.get('/api/v1/meetings?view=mine', { headers: bearer(token) });
  expect(limited.status()).toBe(429);
  const wait = Number(limited.headers()['retry-after']);
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(60);
  expect(await limited.json()).toMatchObject({
    error: { code: 'rate_limited' },
    retry_after: wait,
  });
  // Another token of the same user has its own minute.
  expect(
    (await request.get('/api/v1/meetings?view=mine', { headers: bearer(readToken) })).status(),
  ).toBe(200);
});

test('every read and write through the API is in the audit log with via: api', async ({
  page,
  context,
}) => {
  const rows = d1<{ action: string; meeting_id: string | null; details: string }>(
    `select action, meeting_id, details from audit_events where user_id = '${ida}' order by at, id`,
  );
  const api = rows.filter((r) => r.details && JSON.parse(r.details).via === 'api');
  const formats = api
    .filter((r) => r.action === 'exported')
    .map((r) => JSON.parse(r.details).format)
    .sort();
  // The Word file was served twice (the same bytes); its 304 wrote nothing.
  expect(formats).toEqual(['docx', 'docx', 'json', 'md', 'text', 'transcript']);
  // Once per meeting and hour; the 304 wrote nothing.
  expect(api.filter((r) => r.action === 'opened').map((r) => r.meeting_id)).toEqual(['api-ida-1']);
  for (const r of api) expect(JSON.parse(r.details).token).toMatch(/^Alex /);
  const visibility = api
    .filter((r) => r.action === 'visibility_changed')
    .map((r) => JSON.parse(r.details));
  expect(visibility).toEqual([
    { before: 'private', after: 'shared', via: 'api', token: 'Alex skriver' },
    { before: 'shared', after: 'private', via: 'api', token: 'Alex skriver' },
  ]);
  expect(api.filter((r) => r.action === 'shared')).toHaveLength(2);
  expect(
    rows.filter((r) => r.action === 'api_token_created').map((r) => JSON.parse(r.details)),
  ).toEqual([
    { name: 'Alex læser', scope: 'read' },
    { name: 'Alex skriver', scope: 'read_write' },
    { name: 'Alex travl', scope: 'read' },
  ]);
  // Ole's read of the shared meeting is his own row.
  const oles = d1<{ n: number }>(
    `select count(*) as n from audit_events where user_id = '${ole}' and action = 'opened' and json_extract(details, '$.via') = 'api'`,
  );
  expect(oles[0]!.n).toBe(1);

  // The admin's audit page says so.
  await signIn(context.request, ADMIN);
  await page.goto(`/settings/audit?action=exported&user=${ida}`);
  const table = page.getByTestId('audit-table');
  await expect(table.getByText('Recap as JSON · through the API (Alex læser)')).toBeVisible();
  await page.goto(`/settings/audit?action=api_token_created&user=${ida}`);
  await expect(table.getByText('Alex skriver · Read and write')).toBeVisible();
});

test('revoke: the row goes at once, comes back when the server refuses, and the token is then 401', async ({
  page,
  context,
  request,
}) => {
  await signIn(context.request, IDA);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  const dialog = await openApiTokens(page);
  await expect(dialog.getByRole('heading', { name: '3 tokens' })).toBeVisible();
  // Rule 2: refused, the row comes back with a message.
  await page.route('**/*', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort()
      : route.continue(),
  );
  await dialog.getByRole('button', { name: 'Revoke Alex læser' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Alex læser was not revoked. Try again.');
  await expect(dialog.getByRole('heading', { name: '3 tokens' })).toBeVisible();
  await page.unroute('**/*');
  expect(
    (await request.get('/api/v1/meetings?view=mine', { headers: bearer(readToken) })).status(),
  ).toBe(200);

  await dialog.getByRole('button', { name: 'Revoke Alex læser' }).click();
  await expect(dialog.getByRole('heading', { name: '2 tokens' })).toBeVisible();
  await expect
    .poll(async () =>
      (await request.get('/api/v1/meetings?view=mine', { headers: bearer(readToken) })).status(),
    )
    .toBe(401);
  expect(
    d1<{ details: string }>(
      `select details from audit_events where user_id = '${ida}' and action = 'api_token_revoked'`,
    ).map((r) => JSON.parse(r.details)),
  ).toEqual([{ name: 'Alex læser', scope: 'read' }]);
});

test('keyboard walk of API tokens: menu, dialog, make, copy, done, Escape returns focus (rule 11)', async ({
  page,
  context,
}) => {
  await signIn(context.request, OLE);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  const opener = page.getByRole('complementary').getByRole('button', { name: /^Ole Dahl/ });
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'API tokens' })).toBeFocused();
  await page.keyboard.press('Enter');
  // The dialog's name follows its step's title, so it is found by role alone.
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'API tokens', exact: true })).toBeFocused();
  const create = dialog.getByRole('button', { name: 'New token' });
  await expect(create).toBeVisible();
  await page.keyboard.press('Tab');
  await expectFocusRing(create);
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'New API token' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeFocused();
  await page.keyboard.type('Tastatur');
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Token', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expectFocusRing(dialog.getByRole('button', { name: 'Copy' }));
  await page.keyboard.press('Tab');
  await expectFocusRing(dialog.getByRole('button', { name: 'Done' }));
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'API tokens', exact: true })).toBeFocused();
  await expect(dialog.getByRole('heading', { name: '2 tokens' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('API tokens shows its three states: none, failed with Try again, and a list', async ({
  page,
  context,
}) => {
  await signIn(context.request, ADMIN);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  await page.route('**/*', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort()
      : route.continue(),
  );
  const dialog = await openApiTokens(page);
  await expect(
    dialog.getByText('Could not load your API tokens. Check the connection and try again.'),
  ).toBeVisible();
  await page.unroute('**/*');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  // The admin has none of their own and sees no one else's.
  await expect(dialog.getByText('No API tokens')).toBeVisible();
  await expect(dialog.getByText('Alex skriver')).toHaveCount(0);
});

test('no token reaches the Worker log', () => {
  const log = readFileSync('.wrangler/e2e-worker.log', 'utf8');
  for (const token of [readToken, writeToken, oleToken]) {
    expect(token).toMatch(/^mtxt_/);
    expect(log).not.toContain(token);
  }
});

test.describe('25 tokens with a 64-character name (rule 13)', () => {
  test.beforeAll(() => {
    expect([...LONG_NAME]).toHaveLength(64);
    const now = Date.now();
    const have = d1<{ n: number }>(
      `select count(*) as n from recorder_tokens where user_id = '${ida}' and kind = 'api' and revoked_at is null`,
    )[0]!.n;
    const rows = Array.from({ length: 25 - have }, (_, i) => {
      const name = i === 0 ? LONG_NAME : `Integration ${String(i + 1).padStart(2, '0')}`;
      const hash = createHash('sha256').update(`api-fixture-${i}-${now}`).digest('hex');
      const used = i % 3 === 0 ? 'null' : String(now - i * 3_600_000);
      const scope = i % 2 ? 'read' : 'read_write';
      return `('api-fx-${now}-${i}', 'dev', '${ida}', ${q(name)}, '${hash}', ${now - (i + 1) * 86_400_000}, ${used}, ${now + 300 * 86_400_000}, 'api', '${scope}')`;
    });
    d1(
      `insert into recorder_tokens (id, install_id, user_id, device_name, token_hash, created_at, last_used_at, expires_at, kind, scope) values ${rows.join(', ')}`,
    );
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`API tokens screenshots at ${viewport.width}`, async ({ page, context }) => {
      await signIn(context.request, IDA);
      await page.setViewportSize(viewport);
      await page.goto('/meetings');
      const dialog = await openApiTokens(page);
      await expect(dialog.getByRole('heading', { name: '25 tokens' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /^Revoke / })).toHaveCount(25);
      await expect(dialog.getByText(LONG_NAME)).toBeVisible();
      // Full: New token is off, and the dialog says what to do.
      await expect(dialog.getByRole('button', { name: 'New token' })).toBeDisabled();
      await expect(
        dialog.getByText('You have 25 tokens, the most there can be. Revoke one to make another.'),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await settle(page);
      await page.screenshot({ path: shot(`api-tokens-${viewport.width}`) });

      // The token shown once, at the same width: revoke one to make room.
      await dialog
        .getByRole('button', { name: /^Revoke Integration/ })
        .first()
        .click();
      await expect(dialog.getByRole('heading', { name: '24 tokens' })).toBeVisible();
      await dialog.getByRole('button', { name: 'New token' }).click();
      await dialog
        .getByRole('textbox', { name: 'Name', exact: true })
        .fill(`Skærmbillede ${viewport.width}`);
      await settle(page);
      await page.screenshot({ path: shot(`api-tokens-new-${viewport.width}`) });
      await dialog.getByRole('button', { name: 'Create token' }).click();
      await expect(dialog.getByLabel('Token', { exact: true })).toBeFocused();
      await settle(page);
      await page.screenshot({ path: shot(`api-tokens-secret-${viewport.width}`) });
    });
  }
});
