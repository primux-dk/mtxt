import { expect, test } from '@playwright/test';
import { asUser, d1, DESKTOP, PHONE, settle, shot } from './helpers';

test.beforeEach(async ({ context }) => asUser(context, 'dev'));

/*
  The library on the 30-meeting demo set (`pnpm db:seed --demo=30`), as the
  dev user. Behaviour rules 5 (URL state), 6 (count, pages, Back), 8 (three
  empty states) and 13 (a 120-character title, a 4-hour meeting, one with
  no recording, æ ø å).
*/
const rows = (page: import('@playwright/test').Page) =>
  page.getByTestId('meeting-list').getByRole('listitem');

test.describe('library', () => {
  test('paginates and keeps its state in the URL', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    await expect(page.getByTestId('result-count')).toHaveText('30 meetings');
    await expect(rows(page)).toHaveCount(25);
    await expect(page.getByText('1–25 of 30 meetings')).toBeVisible();
    await expect(page.getByRole('button', { name: /^All\s*30/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const pages = page.getByRole('navigation', { name: 'Pages' });
    await pages.getByRole('link', { name: 'Page 2' }).click();
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(rows(page)).toHaveCount(5);
    await page.reload();
    await expect(rows(page)).toHaveCount(5);
    await expect(pages.getByRole('link', { name: 'Page 2' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.goBack();
    await expect(rows(page)).toHaveCount(25);
  });

  test('search folds case and Danish letters; filters and sort live in the URL', async ({
    page,
  }) => {
    await page.goto('/meetings');
    const search = page.getByRole('searchbox', { name: 'Search the meetings you can see' });
    await search.fill('MØDE');
    await search.press('Enter');
    await expect(page).toHaveURL(/q=M%C3%98DE/);
    await expect(rows(page).first()).toBeVisible();
    for (const title of await rows(page).getByRole('heading').allTextContents()) {
      expect(title.toLowerCase()).toContain('møde');
    }
    await expect(page.getByRole('link', { name: 'Produktionsmøde, uge 43' })).toBeVisible();

    await page.goto('/meetings');
    const failed = page.getByRole('button', { name: /^Failed/ });
    const failedCount = (await failed.textContent())!.replace(/\D/g, '');
    await failed.click();
    await expect(page).toHaveURL(/status=failed/);
    await expect(page.getByTestId('result-count')).toHaveText(
      `${failedCount} ${failedCount === '1' ? 'meeting' : 'meetings'}`,
    );
    for (const row of await rows(page).all()) await expect(row.getByText('Failed')).toBeVisible();

    await page.getByRole('combobox', { name: 'Sort' }).selectOption('title');
    await expect(page).toHaveURL(/sort=title/);
    await expect(page).toHaveURL(/status=failed/);
    const titles = await rows(page).getByRole('heading').allTextContents();
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'da')));
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('title');
    await expect(page.getByRole('button', { name: /^Failed/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Back from a meeting restores the page and the scroll position', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/meetings?sort=title');
    const target = rows(page).nth(18).getByRole('link');
    await target.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(800);
    await target.click();
    await expect(page).toHaveURL(/\/meetings\/demo-/);
    await page.goBack();
    await expect(page).toHaveURL(/\/meetings\?sort=title$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 50);

    // The page's own back link does the same.
    await rows(page).nth(18).getByRole('link').click();
    await page.getByRole('link', { name: 'All meetings' }).click();
    await expect(page).toHaveURL(/\/meetings\?sort=title$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 50);
  });

  test('the three empty states differ (rule 8)', async ({ page, context }) => {
    await page.goto('/meetings?q=zzzzzz');
    await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
    await page.getByRole('link', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    await expect(page.getByTestId('result-count')).toHaveText('30 meetings');

    await page.goto('/meetings?state=failed');
    const alert = page.getByRole('alert');
    await expect(alert.getByRole('heading', { name: 'Could not load meetings' })).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByTestId('result-count')).toHaveCount(0);

    await asUser(context, 'newcomer');
    await page.goto('/meetings');
    await expect(page.getByRole('heading', { name: 'No meetings yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload a file' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record in the browser' })).toBeVisible();
    await page.setViewportSize(DESKTOP);
    await settle(page);
    await page.screenshot({ path: shot('library-empty-1280'), fullPage: true });
  });

  test('the views show what the user may see, and nothing else', async ({ page }) => {
    await page.goto('/meetings?view=shared');
    await expect(page.getByRole('heading', { level: 1, name: 'Shared with me' })).toBeVisible();
    // Exactly the meetings shared with dev in this install (install-scope.spec deletes one).
    const [{ n }] = d1<{ n: number }>(`select count(*) as n from meeting_shares s
      join meetings m on m.id = s.meeting_id and m.install_id = 'dev'
      where s.install_id = 'dev' and s.user_id = 'dev-user' and m.archived_at is null`) as [
      { n: number },
    ];
    await expect(page.getByTestId('result-count')).toHaveText(
      `${n} ${n === 1 ? 'meeting' : 'meetings'}`,
    );
    await page.goto('/meetings?view=company');
    const company = await page.getByTestId('result-count').textContent();
    expect(Number(company!.replace(/\D/g, ''))).toBeGreaterThan(1);
    for (const row of await rows(page).all()) await expect(row.getByText('Company')).toBeVisible();
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`screenshot at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/meetings');
      // Rule 13: the long title wraps and stays readable; the 4-hour meeting says so.
      await expect(page.getByRole('link', { name: /^Årsmøde om økonomi/ })).toBeVisible();
      await expect(page.getByText('4 h', { exact: true })).toBeVisible();
      await expect(page.getByText('No recording').first()).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: shot(`library-${viewport.width}`),
        fullPage: viewport === PHONE ? false : true,
      });
    });
  }
});
