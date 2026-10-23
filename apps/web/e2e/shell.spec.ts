import { expect, test } from '@playwright/test';
import { DESKTOP, expectFocusRing, MEMBER, PHONE, settle, shot, signIn, tabTo } from './helpers';

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
    // Three items; Settings is in the user menu (packet 14).
    const items = ['My meetings', 'Shared with me', 'Whole company'];

    await page.keyboard.press('Tab');
    for (const name of items) {
      await expectFocusRing(nav.getByRole('link', { name }));
      await page.keyboard.press('Tab');
    }
    // Then the user row: Enter opens its menu, arrows move, Escape closes it back onto the row.
    // An admin's menu starts with Settings.
    const userRow = page.getByRole('complementary').getByRole('button', { name: /^Mette Lund/ });
    await expectFocusRing(userRow);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem')).toHaveText(['Settings', 'Recorders', 'Sign out']);
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Recorders' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'API tokens' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(userRow).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(userRow).toBeFocused();

    // Past the sidebar the library header, left to right, then down (packet 12):
    // search, Upload audio, New meeting; the pills, Archived; the sort.
    const search = page.getByRole('searchbox');
    const header = [
      search,
      page.getByRole('button', { name: 'Upload audio' }),
      page.getByRole('button', { name: 'New meeting' }),
      page.getByRole('button', { name: /^All/ }),
      page.getByRole('button', { name: /^Ready/ }),
      page.getByRole('button', { name: /^In progress/ }),
      page.getByRole('button', { name: /^Failed/ }),
      page.getByRole('link', { name: /^Archived/ }),
      page.getByRole('combobox', { name: 'Sort' }),
    ];
    for (const control of header) {
      await page.keyboard.press('Tab');
      // The search field's ring is drawn by its label (focus-within), so the input is only focused.
      if (control === search) await expect(control).toBeFocused();
      else await expectFocusRing(control);
    }

    // Enter on a nav item navigates, and the current item is marked.
    for (let i = 0; i < header.length + 2; i++) await page.keyboard.press('Shift+Tab');
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

    // Ten tabs in a five-control dialog: focus never leaves it.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }

    // The user row opens the same menu inside the Sheet; Escape closes the menu, then the Sheet.
    const userRow = sheet.getByRole('button', { name: /^Mette Lund/ });
    await userRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Recorders' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'API tokens' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(userRow).toBeFocused();
    await expect(sheet).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(menu).toBeFocused();

    // Settings from the Sheet's user menu: it opens the first tab and the Sheet closes.
    await page.keyboard.press('Enter');
    await sheet.getByRole('button', { name: /^Mette Lund/ }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('Settings is in the user menu for an admin only, and marks the row while open', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    const sidebar = page.getByRole('complementary');
    const userRow = sidebar.getByRole('button', { name: /^Mette Lund/ });
    await expect(
      sidebar.getByRole('navigation', { name: 'Main navigation' }).getByRole('link'),
    ).toHaveText(['My meetings', 'Shared with me', 'Whole company']);
    await expect(userRow).not.toHaveAttribute('aria-current');

    await userRow.click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(userRow).toHaveAttribute('aria-current', 'page');
    // No navigation item claims the page.
    await expect(sidebar.locator('nav [aria-current]')).toHaveCount(0);
    await page.goto('/settings/webhooks');
    await expect(userRow).toHaveAttribute('aria-current', 'page');
    await settle(page);
    await page.screenshot({ path: shot('settings-user-menu-1280') });

    // A non-admin's menu has Recorders and Sign out, nothing else.
    await signIn(page, MEMBER);
    await page.goto('/meetings');
    await sidebar.getByRole('button', { name: /^Anne Holm/ }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Recorders', 'Sign out']);
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
