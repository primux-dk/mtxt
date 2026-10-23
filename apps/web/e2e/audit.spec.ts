import { expect } from '@playwright/test';
import { test } from './contract';
import { asUser, d1, DESKTOP, expectFocusRing, PHONE, settle, shot, tabTo } from './helpers';

/*
  The audit log at /settings/audit (packet 6): admins only, metadata only,
  the library's list parts. Rules 5 (URL state), 6 (count and pages), 7
  (the same components), 8 (three empty states), 11 (keyboard), 13 (10,000
  seeded rows).
*/
test.beforeEach(async ({ context }) => asUser(context, 'dev'));

const count = (n: number) => `${n.toLocaleString('en-GB')} events`;

test('pages through 10,000 rows with filters in the URL (rules 5, 6, 13)', async ({ page }) => {
  const [{ n }] = d1<{ n: number }>(
    `select count(*) as n from audit_events where install_id = 'dev'`,
  ) as [{ n: number }];
  expect(n).toBeGreaterThanOrEqual(10_000);
  await page.goto('/settings/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(page.getByTestId('audit-count')).toHaveText(count(n));
  const rows = page.getByTestId('audit-table').locator('tbody tr');
  await expect(rows).toHaveCount(50);
  await expect(page.getByText(`1–50 of ${count(n)}`)).toBeVisible();

  await page.getByRole('link', { name: 'Page 2', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/audit\?page=2$/);
  await expect(page.getByText(`51–100 of ${count(n)}`)).toBeVisible();

  await page.getByRole('button', { name: /^Deleted/ }).click();
  await expect(page).toHaveURL(/\/settings\/audit\?action=deleted$/);
  const [{ deleted }] = d1<{ deleted: number }>(
    `select count(*) as deleted from audit_events where install_id = 'dev' and action = 'deleted'`,
  ) as [{ deleted: number }];
  await expect(page.getByTestId('audit-count')).toHaveText(count(deleted));
  for (const row of (await rows.all()).slice(0, 5)) {
    await expect(row).toContainText('Deleted');
    await expect(row).toContainText('Deleted since');
  }

  await page
    .getByRole('combobox', { name: 'User' })
    .selectOption({ label: 'Jonas Skov (jonas.skov@example.com)' });
  await expect(page).toHaveURL(/action=deleted&user=dev-colleague/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'User' })).toHaveValue('dev-colleague');
  await expect(page.getByRole('button', { name: /^Deleted/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // As in the library, filters replace the history entry and page links add one: Back leaves the filtered view.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/audit$/);
});

test('the three empty states differ (rule 8), and only an admin gets in', async ({
  page,
  context,
}) => {
  await page.goto('/settings/audit?action=mcp_write&user=dev-newcomer');
  await expect(page.getByRole('heading', { name: 'No events match' })).toBeVisible();
  await page.getByRole('link', { name: 'Reset filters' }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/);

  await page.goto('/settings/audit?state=failed');
  await expect(
    page.getByRole('alert').getByRole('heading', { name: 'Could not load the audit log' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  // First use: an install with no events yet. The rows are set aside and put back.
  d1(`create table audit_aside as select * from audit_events; delete from audit_events;`);
  try {
    await page.goto('/settings/audit');
    await expect(page.getByRole('heading', { name: 'No events yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to settings' })).toBeVisible();
  } finally {
    d1(`insert into audit_events select * from audit_aside; drop table audit_aside;`);
  }

  await asUser(context, 'newcomer');
  const response = await page.goto('/settings/audit');
  expect(response?.status()).toBe(403);
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible();
});

test('keyboard walk: nav, filters, the table and the pages (rule 11)', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings/audit');
  const order = [
    page.getByRole('link', { name: 'Settings', exact: true }).last(),
    page.getByRole('link', { name: 'Audit log' }),
    page.getByRole('button', { name: /^All/ }),
  ];
  await tabTo(page, order[0]!);
  for (const control of order.slice(1)) {
    await page.keyboard.press('Tab');
    await expectFocusRing(control);
  }
  await tabTo(page, page.getByRole('combobox', { name: 'User' }));
  await expectFocusRing(page.getByRole('combobox', { name: 'User' }));
  // The table scrolls sideways inside itself, so it takes focus for the arrow keys.
  await page.keyboard.press('Tab');
  await expectFocusRing(page.getByRole('region', { name: 'Audit events, newest first' }));
  await tabTo(page, page.getByRole('link', { name: 'Page 2', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/page=2/);
});

for (const viewport of [DESKTOP, PHONE]) {
  test(`audit page screenshot at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/settings/audit');
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`audit-${viewport.width}`) });
  });
}
