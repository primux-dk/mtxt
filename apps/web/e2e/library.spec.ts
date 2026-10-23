import { expect, test } from '@playwright/test';
import { meetingWithAudio } from './access-helpers';
import {
  asUser,
  d1,
  DESKTOP,
  expectFocusRing,
  PHONE,
  settle,
  shot,
  signIn,
  tabTo,
} from './helpers';

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
    // Packet 6: a hit is in the title, or in a transcript or recap, shown as a marked snippet.
    for (const row of await rows(page).all()) {
      const title = (await row.getByRole('heading').textContent())!.toLowerCase();
      if (title.includes('møde')) continue;
      const marks = await row.getByTestId('search-snippet').locator('mark').allTextContents();
      expect(
        marks.some((m) => m.toLowerCase().startsWith('møde')),
        title,
      ).toBe(true);
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
    for (const viewport of [DESKTOP, PHONE]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await page.screenshot({ path: shot(`library-empty-${viewport.width}`), fullPage: true });
    }
  });

  test('the Archived link counts archived meetings only when there are some; the archived view', async ({
    page,
    context,
  }) => {
    // A user of their own, so the count does not depend on what other specs archive.
    await signIn(context.request, { email: 'asger.arkiv@example.com', name: 'Asger Arkiv' });
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    const archived = page.getByRole('link', { name: /^Archived/ });
    await expect(archived).toHaveAccessibleName('Archived');
    await expect(archived).toHaveText('Archived');

    for (const title of ['Budgetmøde, første udkast', 'Kvartalsmøde, 2. kvartal']) {
      const { meetingId } = await meetingWithAudio(context.request, {}, title);
      await page.goto(`/meetings/${meetingId}`);
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Archive' }).click();
      await expect(page.getByText('This meeting is archived.', { exact: false })).toBeVisible();
    }
    await page.goto('/meetings');
    await expect(archived).toHaveAccessibleName('Archived 2');

    // The archived view: its own title, the way back in the link's place, the pills apply.
    await archived.click();
    await expect(page).toHaveURL(/\/meetings\?view=archived$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Archived meetings' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Archived/ })).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByTestId('result-count')).toHaveText('2 meetings');
    await expect(page.getByRole('button', { name: /^All\s*2/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('searchbox')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New meeting' })).toBeVisible();
    for (const viewport of [DESKTOP, PHONE]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await page.screenshot({ path: shot(`library-archived-${viewport.width}`) });
    }
    await page.getByRole('link', { name: 'Back to My meetings' }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'My meetings' })).toBeVisible();
  });

  test('on a phone the header reads title and New meeting, search, pills and Archived, sort (rule 11)', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/meetings');
    await tabTo(page, page.getByRole('button', { name: 'Open navigation' }));
    const search = page.getByRole('searchbox');
    for (const control of [
      page.getByRole('button', { name: 'New meeting' }),
      search,
      page.getByRole('button', { name: /^All/ }),
      page.getByRole('button', { name: /^Ready/ }),
      page.getByRole('button', { name: /^In progress/ }),
      page.getByRole('button', { name: /^Failed/ }),
      page.getByRole('link', { name: /^Archived/ }),
      page.getByRole('combobox', { name: 'Sort' }),
    ]) {
      await page.keyboard.press('Tab');
      // The search field's ring is drawn by its label (focus-within), so the input is only focused.
      if (control === search) await expect(control).toBeFocused();
      else await expectFocusRing(control);
    }
    // The pills stay on one line and scroll; Upload audio is in New meeting's menu here.
    const pills = await page.getByRole('group', { name: 'Filters' }).boundingBox();
    expect(pills!.height).toBeLessThan(56);
    await expect(page.getByRole('button', { name: 'Upload audio' })).toHaveCount(0);
    await page.getByRole('button', { name: 'New meeting' }).click();
    await expect(page.getByRole('menuitem', { name: 'Upload a file' })).toBeVisible();
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
