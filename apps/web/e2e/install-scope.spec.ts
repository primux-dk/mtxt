import { expect } from '@playwright/test';
import { test } from './contract';
import { asUser, d1, SESSION_HEADERS, signInHeaders } from './helpers';

test.beforeEach(async ({ context }) => asUser(context, 'dev'));

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/*
  The demo seed plants rows from a second install (FOREIGN_INSTALL in
  packages/adapters/src/db/dev-seed.ts): a company meeting, a share naming
  the newcomer on the colleague's shared meeting, and a recording attached
  to the dev user's first meeting. None of it may be visible or usable.
*/
test('a company meeting of another install is in no view and opens nowhere', async ({ page }) => {
  await page.goto('/meetings?view=company');
  await expect(page.getByRole('link', { name: 'Fremmed møde' })).toHaveCount(0);
  await page.goto('/meetings?view=company&q=fremmed');
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
  expect((await page.goto('/meetings/foreign-meeting'))?.status()).toBe(404);
});

test("another install's share row grants nothing", async ({ page, context }) => {
  await asUser(context, 'newcomer');
  expect((await page.goto('/meetings/demo-colleague-0001'))?.status()).toBe(404);
  await page.goto('/meetings?view=shared');
  await expect(page.getByRole('heading', { name: 'Nothing shared with you yet' })).toBeVisible();
});

test("another install's recording on a local meeting is not shown, served or writable", async ({
  page,
  request,
}) => {
  await page.goto('/meetings/demo-0000');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Produktionsmøde, uge 43');
  // One recording of its own: no Recordings list, and the player plays the local one.
  await expect(page.getByRole('heading', { name: 'Recordings' })).toHaveCount(0);
  await expect(page.locator('audio')).toHaveAttribute(
    'src',
    '/api/v1/recordings/demo-0000-r1/audio',
  );

  const dev = SESSION_HEADERS.dev;
  expect(
    (await request.get('/api/v1/recordings/foreign-recording', { headers: dev })).status(),
  ).toBe(404);
  expect(
    (await request.get('/api/v1/recordings/foreign-recording/audio', { headers: dev })).status(),
  ).toBe(404);
  const put = await request.put('/api/v1/recordings/foreign-recording/chunks/1', {
    headers: { ...dev, 'content-type': 'application/octet-stream' },
    data: Buffer.from('x'),
  });
  expect(put.status()).toBe(404);
  expect(
    (
      await request.post('/api/v1/recordings/foreign-recording/complete', { headers: dev })
    ).status(),
  ).toBe(404);
});

const COUNTS = `select
  (select count(*) from meetings where id = 'demo-graph') as meetings,
  (select count(*) from recordings where meeting_id = 'demo-graph') as recordings,
  (select count(*) from transcripts where id = 'demo-graph-t1') as transcripts,
  (select count(*) from segments where transcript_id = 'demo-graph-t1') as segments,
  (select count(*) from speakers where meeting_id = 'demo-graph') as speakers,
  (select count(*) from recaps where id = 'demo-graph-c1') as recaps,
  (select count(*) from recap_versions where recap_id = 'demo-graph-c1') as versions,
  (select count(*) from decisions where recap_id = 'demo-graph-c1') as decisions,
  (select count(*) from meeting_shares where meeting_id = 'demo-graph') as shares,
  (select count(*) from audit_events where meeting_id = 'demo-graph') as audit`;

async function openMenu(page: import('@playwright/test').Page, item: string) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test("delete and archive are refused, with nothing removed, when another install's rows hang off the meeting", async ({
  page,
}) => {
  const foreign = () =>
    d1<{ n: number }>(
      `select count(*) as n from recordings where id = 'foreign-recording' and install_id = 'other-install'`,
    )[0]!.n;
  expect(foreign()).toBe(1);
  await page.goto('/meetings/demo-0000');
  await openMenu(page, 'Delete…');
  const dialog = page.getByRole('dialog', { name: 'Delete this meeting?' });
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Data from another installation depends on this meeting, so it was left as it is. Contact your admin.',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(foreign()).toBe(1);
  await expect
    .poll(() => d1(`select id from recordings where id = 'demo-0000-r1'`))
    .toHaveLength(1);
  await expect
    .poll(() => d1(`select id from meetings where id = 'demo-0000' and archived_at is null`))
    .toHaveLength(1);

  await openMenu(page, 'Archive');
  await expect(
    page.getByText('Data from another installation depends on this meeting'),
  ).toBeVisible();
  await expect
    .poll(() => d1(`select id from meetings where id = 'demo-0000' and archived_at is null`))
    .toHaveLength(1);
});

test('delete removes every row under the meeting, table by table, and nothing of another install', async ({
  page,
  context,
}) => {
  await asUser(context, 'colleague');
  expect(d1(COUNTS)[0]).toEqual({
    meetings: 1,
    recordings: 1,
    transcripts: 1,
    segments: 3,
    speakers: 1,
    recaps: 1,
    versions: 1,
    decisions: 1,
    shares: 1,
    audit: 1,
  });
  await page.goto('/meetings/demo-graph');
  await openMenu(page, 'Delete…');
  await page
    .getByRole('dialog', { name: 'Delete this meeting?' })
    .getByRole('button', { name: 'Delete permanently' })
    .click();
  await expect(page).toHaveURL(/\/meetings$/);
  expect(Object.values(d1(COUNTS)[0]!).every((n) => n === 0)).toBe(true);
  await expect
    .poll(() => d1(`select id from meetings where id = 'foreign-meeting'`))
    .toHaveLength(1);
  await expect
    .poll(() => d1(`select id from recordings where id = 'foreign-recording'`))
    .toHaveLength(1);
  // The audit log outlives the meeting (packet 6): its row is detached and keeps the title.
  await expect
    .poll(() => d1(`select meeting_id, meeting_title from audit_events where id = 'demo-graph-a1'`))
    .toEqual([{ meeting_id: null, meeting_title: 'Møde med alt i' }]);
});
