import { expect } from '@playwright/test';
import { test } from './contract';
import { asUser, DESKTOP, PHONE, settle, shot } from './helpers';

/*
  The browser recorder on Chromium's fake microphone
  (--use-fake-device-for-media-stream in playwright.config.ts), as the
  seeded colleague. Rules 9 (three distinct failure states), 10 (Record and
  Stop are the primary) and 11 (real buttons, focus moves to Stop).
*/
test.beforeEach(async ({ context }) => {
  await asUser(context, 'colleague');
  await context.grantPermissions(['microphone']);
});

test('records 3 seconds, uploads while recording, and opens the meeting', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings/new');
  await page.getByLabel('Meeting title').fill('Optaget i browseren');
  await settle(page);
  await page.screenshot({ path: shot('recorder-1280') });

  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeFocused();
  await expect(page.getByTestId('recording-indicator')).toHaveText('Recording');
  await expect(page.getByTestId('elapsed')).toHaveText('00:03', { timeout: 10_000 });
  await page.screenshot({ path: shot('recorder-recording-1280') });
  await stop.click();

  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Optaget i browseren');
  await expect(page.getByRole('heading', { name: 'Transcribing' })).toBeVisible();
  await expect(page.getByText('Browser', { exact: false }).first()).toBeAttached();
});

test('the recorder on a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/meetings/new');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId('elapsed')).toHaveText('00:01', { timeout: 10_000 });
  await settle(page);
  await page.screenshot({ path: shot('recorder-390'), fullPage: true });
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
});

const failures = [
  {
    name: 'permission denied',
    script: `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError'));`,
    title: 'Microphone access is blocked',
    retry: true,
  },
  {
    name: 'no microphone',
    script: `navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('none', 'NotFoundError'));`,
    title: 'No microphone found',
    retry: true,
  },
  {
    name: 'unsupported browser',
    script: `delete window.MediaRecorder;`,
    title: 'This browser cannot record',
    retry: false,
  },
];

for (const failure of failures) {
  test(`${failure.name} says what to do next`, async ({ page }) => {
    await page.addInitScript(failure.script);
    await page.goto('/meetings/new');
    if (failure.retry) await page.getByRole('button', { name: 'Record', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: failure.title });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(
      failure.retry ? 1 : 0,
    );
    await expect(alert.getByRole('button', { name: 'Upload a file instead' })).toBeVisible();
  });
}

async function recordAndStop(page: import('@playwright/test').Page, title: string) {
  await page.goto('/meetings/new');
  await page.getByLabel('Meeting title').fill(title);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(page.getByTestId('elapsed')).toHaveText('00:01', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop' }).click();
}

test('an unconfirmed recording survives in-app navigation, behind a confirm dialog', async ({
  page,
}) => {
  // Every chunk and complete fails, as with no network.
  await page.route('**/api/v1/recordings/*/c*', (route) => route.abort('internetdisconnected'));
  await recordAndStop(page, 'Optagelse uden net');
  await expect(
    page.getByRole('alert').filter({ hasText: 'The recording is not saved yet' }),
  ).toBeVisible({
    timeout: 60_000,
  });

  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'My meetings' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Leave without uploading?' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/meetings\/new$/);
  await dialog.getByRole('button', { name: 'Leave' }).click();
  await expect(page).toHaveURL(/\/meetings$/);

  // Back on the recorder: the same recording, with Retry.
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByRole('menuitem', { name: 'Record in the browser' }).click();
  await expect(page).toHaveURL(/\/meetings\/new$/);
  await expect(page.getByLabel('Meeting title')).toHaveValue('Optagelse uden net');
  const alert = page.getByRole('alert').filter({ hasText: 'The recording is not saved yet' });
  await expect(alert).toBeVisible();
  await page.unrouteAll();
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Optagelse uden net');
});

test('a confirmation whose answer was lost counts as confirmed on retry', async ({ page }) => {
  let completes = 0;
  // The server confirms every complete, and every answer is lost.
  await page.route('**/api/v1/recordings/*/complete', async (route) => {
    completes++;
    await route.fetch();
    await route.abort('connectionreset');
  });
  let puts = 0;
  await page.route('**/api/v1/recordings/*/chunks/*', (route) => {
    puts++;
    return route.continue();
  });
  await recordAndStop(page, 'Tabt svar');
  const alert = page.getByRole('alert').filter({ hasText: 'The recording is not saved yet' });
  await expect(alert).toBeVisible({ timeout: 60_000 });
  expect(completes).toBeGreaterThan(0);
  const putsBefore = puts;
  await page.unroute('**/api/v1/recordings/*/complete');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tabt svar');
  // The GET said confirmed: no chunk was sent again and no second recording made.
  expect(puts).toBe(putsBefore);
  await expect(page.getByRole('heading', { name: 'Recordings' })).toHaveCount(0);
});

test('a failed upload is never resumed: a new recording is made from the kept audio', async ({
  page,
}) => {
  let corrupted = false;
  await page.route('**/api/v1/recordings/*/complete', async (route) => {
    if (corrupted) return route.continue();
    corrupted = true;
    const body = JSON.parse(route.request().postData() ?? '{}');
    await route.continue({ postData: JSON.stringify({ ...body, sha256: 'f'.repeat(64) }) });
  });
  await recordAndStop(page, 'Forkert hash');
  const alert = page.getByRole('alert').filter({ hasText: 'The recording is not saved yet' });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  // The same meeting, now with the failed recording and the confirmed one.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Forkert hash');
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transcribing' })).toBeVisible();
});

test('after Leave, every page warns on unload until the audio is discarded by name', async ({
  page,
}) => {
  await page.route('**/api/v1/recordings/*/c*', (route) => route.abort('internetdisconnected'));
  await recordAndStop(page, 'Optagelse der skal kasseres');
  await expect(
    page.getByRole('alert').filter({ hasText: 'The recording is not saved yet' }),
  ).toBeVisible({ timeout: 60_000 });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'My meetings' })
    .click();
  await page
    .getByRole('dialog', { name: 'Leave without uploading?' })
    .getByRole('button', { name: 'Leave' })
    .click();
  await expect(page).toHaveURL(/\/meetings$/);

  // A reload on the library asks first; declining keeps the page and the audio.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.getByRole('heading', { level: 1 }).click(); // a gesture, so Chromium may ask
  await page.evaluate(() => location.reload());
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  await expect(page).toHaveURL(/\/meetings$/);

  // Discard, by name, on the New meeting page.
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByRole('menuitem', { name: 'Record in the browser' }).click();
  await page.getByRole('button', { name: 'Discard recording' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard the recording?' });
  await expect(discard).toContainText('“Optagelse der skal kasseres”');
  await expect(discard).toContainText('there is no other copy');
  await discard.getByRole('button', { name: 'Discard recording' }).click();
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: 'not saved yet' })).toHaveCount(0);

  // Nothing held: the next reload goes ahead without a question.
  await page.unrouteAll();
  await page.getByRole('heading', { level: 1 }).click();
  await page.reload();
  expect(dialogs).toEqual(['beforeunload']);
});
