import { expect, test } from '@playwright/test';
import { asUser, DESKTOP, PHONE, settle, shot } from './helpers';

/*
  The browser recorder on Chromium's fake microphone
  (--use-fake-device-for-media-stream in playwright.config.ts), as the
  seeded colleague. Rules 9 (three distinct failure states), 10 (Record and
  Stop are the primary) and 11 (real buttons, focus moves to Stop).
*/
test.beforeEach(async ({ context, baseURL }) => {
  await asUser(context, 'colleague', baseURL!);
  await context.grantPermissions(['microphone']);
});

test('records 3 seconds, uploads while recording, and opens the meeting', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings/new');
  await page.getByLabel('Meeting title').fill('Optaget i browseren');
  await settle(page);
  await page.screenshot({ path: shot('recorder-1280') });

  await page.getByRole('button', { name: 'Record' }).click();
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
  await page.getByRole('button', { name: 'Record' }).click();
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
    if (failure.retry) await page.getByRole('button', { name: 'Record' }).click();
    const alert = page.getByRole('alert').filter({ hasText: failure.title });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Try again' })).toHaveCount(
      failure.retry ? 1 : 0,
    );
    await expect(alert.getByRole('button', { name: 'Upload a file instead' })).toBeVisible();
  });
}
