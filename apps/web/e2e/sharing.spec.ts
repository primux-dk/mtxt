import { expect } from '@playwright/test';
import { test } from './contract';
import { dropActions, meetingWithAudio } from './access-helpers';
import {
  asUser,
  d1,
  DESKTOP,
  expectFocusRing,
  PHONE,
  SESSION_HEADERS,
  settle,
  shot,
  signInHeaders,
  tabTo,
} from './helpers';

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/*
  Visibility and sharing (packet 6). The colleague (Jonas) owns the
  meetings; the newcomer (Anne) is the colleague they share with; the dev
  user (Mette) is the admin, who reads nothing she is not given. Rules 2
  (optimistic with rollback), 7 (the share dialog is the Dialog), 11
  (focus trap and return), 13 (a meeting shared with 40).
*/
const { colleague, newcomer, dev } = SESSION_HEADERS;

test('the owner shares with a colleague, who then sees it; the admin does not, but sees the log', async ({
  page,
  context,
  browser,
  request,
}) => {
  await asUser(context, 'colleague');
  const { meetingId, recordingId } = await meetingWithAudio(request, colleague, 'Hemmeligt budget');
  expect((await request.get(`/meetings/${meetingId}`, { headers: newcomer })).status()).toBe(404);

  await page.goto(`/meetings/${meetingId}`);
  const visibility = page.getByRole('combobox', {
    name: 'Visibility, only the owner can change it',
  });
  await expect(visibility).toHaveValue('private');
  await visibility.selectOption('shared');
  const dialog = page.getByRole('dialog', { name: 'Share “Hemmeligt budget”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Find a colleague')).toBeFocused();
  await dialog.getByLabel('Find a colleague').fill('anne');
  await dialog.getByRole('button', { name: 'Add Anne Holm' }).click();
  await expect(dialog.getByTestId('share-readers')).toContainText('Anne Holm');
  await expect(dialog.getByRole('heading', { name: '1 person has access' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const manage = page.getByRole('button', { name: 'Shared with 1 person' });
  await expect(manage).toBeFocused();

  await page.reload();
  await expect(visibility).toHaveValue('shared');
  await expect(manage).toBeVisible();

  // Anne reads it now: the page, the audio, the API, her "Shared with me", and search.
  const anne = await browser.newContext();
  await asUser(anne, 'newcomer');
  const annePage = await anne.newPage();
  await annePage.goto(`/meetings/${meetingId}`);
  await expect(annePage.getByRole('heading', { level: 1 })).toHaveText('Hemmeligt budget');
  await expect(annePage.getByText('Shared', { exact: true })).toBeVisible();
  await expect(annePage.getByRole('combobox', { name: /Visibility/ })).toHaveCount(0);
  await annePage.goto('/meetings?view=shared&q=hemmeligt');
  await expect(annePage.getByRole('link', { name: 'Hemmeligt budget' })).toBeVisible();
  expect((await anne.request.get(`/api/v1/recordings/${recordingId}/audio`)).status()).toBe(200);
  await anne.close();

  // The admin is not named: nothing, anywhere.
  expect((await request.get(`/meetings/${meetingId}`, { headers: dev })).status()).toBe(404);
  expect(
    (await request.get(`/api/v1/recordings/${recordingId}/audio`, { headers: dev })).status(),
  ).toBe(404);
  expect((await request.get(`/api/v1/recordings/${recordingId}`, { headers: dev })).status()).toBe(
    404,
  );

  // Back to private: the share rows go, and Anne is out again.
  await visibility.selectOption('private');
  await expect(manage).toHaveCount(0);
  await expect
    .poll(() => d1(`select count(*) as n from meeting_shares where meeting_id = '${meetingId}'`))
    .toEqual([{ n: 0 }]);
  expect((await request.get(`/meetings/${meetingId}`, { headers: newcomer })).status()).toBe(404);

  // The admin's view: the title and what happened, never the content.
  await asUser(context, 'dev');
  await page.goto('/settings/audit');
  const table = page.getByTestId('audit-table');
  const rowsFor = table.getByRole('row').filter({ hasText: 'Hemmeligt budget' });
  await expect(rowsFor).toHaveCount(4);
  await expect(rowsFor.filter({ hasText: 'Opened' })).toContainText('Anne Holm');
  await expect(rowsFor.filter({ hasText: 'Sharing changed' })).toContainText('Added Anne Holm');
  await expect(rowsFor.filter({ hasText: 'Private → Shared' })).toContainText('Jonas Skov');
  await expect(rowsFor.filter({ hasText: 'Shared → Private' })).toContainText('1 share removed');
  // Opened once, however often Anne loaded the page and the audio.
  expect(
    d1(
      `select count(*) as n from audit_events where meeting_id = '${meetingId}' and action = 'opened'`,
    ),
  ).toEqual([{ n: 1 }]);
  // And the admin's own search does not find it.
  await page.goto('/meetings?view=company&q=hemmeligt');
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
});

test('the permission matrix: page, audio, API and search for every role', async ({ request }) => {
  // One meeting per visibility, made by the owner, set up directly in the database.
  const made: Record<string, { meetingId: string; recordingId: string }> = {};
  for (const v of ['private', 'shared', 'company'] as const) {
    made[v] = await meetingWithAudio(request, colleague, `Matrix ${v} kvadratrod`);
    d1(`update meetings set visibility = '${v}' where id = '${made[v].meetingId}'`);
  }
  d1(
    `insert into meeting_shares (install_id, meeting_id, user_id) values ('dev', '${made.shared!.meetingId}', 'dev-newcomer')`,
  );
  // The outsider: a colleague named on nothing (a seeded demo person).
  const outsider = await (async () => {
    const ctx = await (
      await import('@playwright/test')
    ).request.newContext({
      baseURL: test.info().project.use.baseURL,
    });
    await ctx.post('/api/test/sign-in', {
      data: { email: 'sofie.01@example.com', name: 'Sofie Østergaard' },
    });
    const { cookies } = await ctx.storageState();
    await ctx.dispose();
    return { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
  })();

  const roles = { owner: colleague, reader: newcomer, admin: dev, outsider } as const;
  const expected: Record<string, Record<keyof typeof roles, boolean>> = {
    private: { owner: true, reader: false, admin: false, outsider: false },
    shared: { owner: true, reader: true, admin: false, outsider: false },
    company: { owner: true, reader: true, admin: true, outsider: true },
  };
  for (const [v, ids] of Object.entries(made)) {
    for (const [role, headers] of Object.entries(roles) as [
      keyof typeof roles,
      Record<string, string>,
    ][]) {
      const may = expected[v]![role];
      const status = may ? 200 : 404;
      const where = `${role} on ${v}`;
      expect((await request.get(`/meetings/${ids.meetingId}`, { headers })).status(), where).toBe(
        status,
      );
      expect(
        (await request.get(`/api/v1/recordings/${ids.recordingId}/audio`, { headers })).status(),
        where,
      ).toBe(status);
      expect(
        (await request.get(`/api/v1/recordings/${ids.recordingId}`, { headers })).status(),
        where,
      ).toBe(status);
      let found = false;
      for (const view of ['mine', 'shared', 'company']) {
        const html = await (
          await request.get(`/meetings?view=${view}&q=Matrix%20${v}%20kvadratrod`, { headers })
        ).text();
        found ||= html.includes(`/meetings/${ids.meetingId}`);
      }
      expect(found, `search: ${where}`).toBe(may);
    }
  }
});

test('visibility and sharing roll back when the server does not get them (rule 2)', async ({
  page,
  context,
  request,
}) => {
  await asUser(context, 'colleague');
  const { meetingId } = await meetingWithAudio(request, colleague, 'Rul tilbage');
  await page.goto(`/meetings/${meetingId}`);
  const visibility = page.getByRole('combobox', {
    name: 'Visibility, only the owner can change it',
  });

  await dropActions(page);
  await visibility.selectOption('company');
  await expect(page.getByText('Visibility was not saved. It is back to Private.')).toBeVisible();
  await expect(visibility).toHaveValue('private');
  await page.unroute('**/*');
  await page.reload();
  await expect(visibility).toHaveValue('private');

  // The audit insert fails: the change does not land either, and the screen says so.
  d1(
    `create trigger e2e_no_audit before insert on audit_events begin select raise(abort, 'audit down'); end`,
  );
  try {
    await visibility.selectOption('company');
    await expect(page.getByText('Visibility was not saved. It is back to Private.')).toBeVisible();
    await expect(visibility).toHaveValue('private');
    expect(d1(`select visibility from meetings where id = '${meetingId}'`)).toEqual([
      { visibility: 'private' },
    ]);
    expect(
      (await request.get(`/meetings/${meetingId}`, { headers: SESSION_HEADERS.newcomer })).status(),
    ).toBe(404);
  } finally {
    d1(`drop trigger e2e_no_audit`);
  }
  await page.reload();

  // Shared is saved; then an add that does not arrive comes off the list again.
  await visibility.selectOption('shared');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Saving the visibility first…')).toHaveCount(0);
  await dialog.getByLabel('Find a colleague').fill('anne');
  await expect(dialog.getByRole('button', { name: 'Add Anne Holm' })).toBeEnabled();
  await dropActions(page);
  await dialog.getByRole('button', { name: 'Add Anne Holm' }).click();
  await expect(dialog.getByText('Anne Holm was not added. Try again.')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Nobody else has access' })).toBeVisible();
  await page.unroute('**/*');
  expect(d1(`select count(*) as n from meeting_shares where meeting_id = '${meetingId}'`)).toEqual([
    { n: 0 },
  ]);
  // A retry adds her once.
  await dialog.getByRole('button', { name: 'Add Anne Holm' }).click();
  await expect(dialog.getByRole('heading', { name: '1 person has access' })).toBeVisible();
  await expect
    .poll(() => d1(`select count(*) as n from meeting_shares where meeting_id = '${meetingId}'`))
    .toEqual([{ n: 1 }]);
});

test('keyboard walk of the share dialog: focus trapped, returned to its opener (rule 11)', async ({
  page,
  context,
}) => {
  await asUser(context, 'dev');
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings/demo-0001');
  const manage = page.getByRole('button', { name: 'Shared with 40 people' });
  await tabTo(page, manage);
  await expectFocusRing(manage);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Find a colleague')).toBeFocused();
  // Rule 13: 40 colleagues, each with a remove button, in a list that scrolls.
  await expect(dialog.getByRole('heading', { name: '40 people have access' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(40);

  await dialog.getByLabel('Find a colleague').fill('jonas');
  await expect(dialog.getByRole('button', { name: 'Add Jonas Skov' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expectFocusRing(dialog.getByRole('button', { name: 'Add Jonas Skov' }));
  await page.keyboard.press('Tab');
  await expectFocusRing(dialog.getByRole('button', { name: 'Remove Asta Dahl' }));
  // Shift+Tab from the field wraps to the dialog's last control: focus stays inside.
  await dialog.getByLabel('Find a colleague').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Find a colleague')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(manage).toBeFocused();
});

for (const viewport of [DESKTOP, PHONE]) {
  test(`share dialog screenshot at ${viewport.width}`, async ({ page, context }) => {
    await asUser(context, 'dev');
    await page.setViewportSize(viewport);
    await page.goto('/meetings/demo-0001');
    await page.getByRole('button', { name: 'Shared with 40 people' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Find a colleague').fill('jonas');
    await expect(dialog.getByRole('button', { name: 'Add Jonas Skov' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`share-dialog-${viewport.width}`) });
  });
}
