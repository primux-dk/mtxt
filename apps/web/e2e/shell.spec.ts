import { expect, test } from '@playwright/test';
import { DESKTOP, expectFocusRing, PHONE, shot, signIn, tabTo } from './helpers';

// Every page needs a session since packet 2.
test.beforeEach(async ({ page }) => signIn(page));

test.describe('design pages', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    test(`/design at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const response = await page.goto('/design');
      expect(response?.url()).toMatch(/\/design\/$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Design guidelines' }),
      ).toBeVisible();
      // The install's theme values are injected, and tokens.css loads from /design/.
      const accent = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--theme-accent').trim(),
      );
      expect(accent).toBe('#566b45');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('16px "Mona Sans"'))).toBe(true);
      await page.screenshot({ path: shot(`design-${viewport.width}`) });
    });
  }
});

test.describe('keyboard and focus (rule 11)', () => {
  test('walk the sidebar with the keyboard', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const items = ['My meetings', 'Shared with me', 'Whole company', 'Settings'];

    await page.keyboard.press('Tab');
    for (const name of items) {
      await expectFocusRing(nav.getByRole('link', { name }));
      await page.keyboard.press('Tab');
    }
    // Then the user slot's "Recorders" and "Sign out", and past the sidebar the page: the search field first.
    await expectFocusRing(page.getByRole('button', { name: 'Recorders', exact: true }));
    await page.keyboard.press('Tab');
    await expectFocusRing(page.getByRole('button', { name: 'Sign out' }));
    await page.keyboard.press('Tab');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Tab');
    await expectFocusRing(page.getByRole('button', { name: 'Upload audio' }));
    await page.keyboard.press('Tab');
    await expectFocusRing(page.getByRole('button', { name: 'New meeting' }));

    // Enter on a nav item navigates, and the current item is marked.
    for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+Tab');
    await expect(nav.getByRole('link', { name: 'Shared with me' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/view=shared/);
    await expect(nav.getByRole('link', { name: 'Shared with me' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Shared with me' })).toBeVisible();
  });

  test('the mobile Sheet traps focus and returns it', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/meetings');
    const menu = page.getByRole('button', { name: 'Open navigation' });
    await tabTo(page, menu);
    await expectFocusRing(menu);
    await page.keyboard.press('Enter');

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState === 'finished'),
    );
    await page.screenshot({ path: shot('sheet-390') });

    // Ten tabs in a six-control dialog: focus never leaves it.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(menu).toBeFocused();
  });
});

test.describe('motion (rule 12)', () => {
  test('150 ms state changes, none under reduced motion', async ({ page }) => {
    await page.goto('/meetings');
    const link = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link')
      .first();
    expect(await link.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.15s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await link.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  });
});
