import { expect } from '@playwright/test';
import { test } from './contract';
import { asUser, DESKTOP, settle, shot } from './helpers';

/*
  Search over titles, transcripts and recaps, through the library's own
  box (packet 6). The seed gives the colleague two meetings with the same
  transcript: one company-wide, one private. The dev user finds only the
  first, with a snippet whose hits are marked (rules 5, 8).
*/
test.beforeEach(async ({ context }) => asUser(context, 'dev'));

test('a word in a transcript finds the meeting, with a marked snippet that opens at its time', async ({
  page,
}) => {
  await page.goto('/meetings?view=company');
  await page.getByRole('searchbox', { name: 'Search the meetings you can see' }).fill('ugeplan');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=company&q=ugeplan/);
  await expect(page.getByTestId('result-count')).toHaveText('1 meeting');
  await expect(page.getByRole('link', { name: 'Linjemøde, alle' })).toBeVisible();
  await expect(page.getByText('Linjemøde, kun ejeren')).toHaveCount(0);
  const snippet = page.getByTestId('search-snippet');
  await expect(snippet).toContainText('Transcript');
  await expect(snippet).toContainText('samle tallene i ugeplanen?');
  await expect(snippet.locator('mark')).toHaveText('ugeplanen');
  // Ranked by relevance; the sort says so.
  await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('relevance');
  await page.setViewportSize(DESKTOP);
  await settle(page);
  await page.screenshot({ path: shot('search-1280') });

  await snippet.getByRole('link').click();
  await expect(page).toHaveURL(/\/meetings\/demo-search-company\?t=1218$/);
});

test('search keeps the library’s three empty states (rule 8)', async ({ page }) => {
  await page.goto('/meetings?q=xyzzyplugh');
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
  await expect(
    page.getByText('No meeting you can see has “xyzzyplugh” in its title, transcript or recap.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Reset filters' }).click();
  await expect(page).toHaveURL(/\/meetings$/);

  await page.goto('/meetings?q=ugeplan&state=failed');
  await expect(
    page.getByRole('alert').getByRole('heading', { name: 'Could not load meetings' }),
  ).toBeVisible();

  // Input that is FTS syntax is only words.
  await page.goto(`/meetings?view=company&q=${encodeURIComponent('"ugeplan* OR (NEAR')}`);
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
});
