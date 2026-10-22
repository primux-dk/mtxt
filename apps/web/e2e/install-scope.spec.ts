import { expect, test } from '@playwright/test';
import { asUser } from './helpers';

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

test("another install's share row grants nothing", async ({ page, context, baseURL }) => {
  await asUser(context, 'newcomer', baseURL!);
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

  const dev = { 'x-mtxt-test-user': 'dev' };
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
