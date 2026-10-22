import { expect } from '@playwright/test';
import { test } from './contract';
import {
  asUser,
  DESKTOP,
  PHONE,
  settle,
  sha256,
  shot,
  wav,
  SESSION_HEADERS,
  signInHeaders,
} from './helpers';

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/* The upload dialog (rules 9 and 11), as the seeded colleague. */
const colleague = SESSION_HEADERS.colleague;

test.beforeEach(async ({ context }) => asUser(context, 'colleague'));

test('upload a file through the dialog and land on the meeting page', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  await page.getByRole('button', { name: 'Upload audio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload audio' });
  await expect(dialog.getByRole('button', { name: 'Choose a file' })).toBeFocused();

  // Not audio: said at the dialog, with what to choose instead.
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(dialog.getByRole('alert')).toContainText('This is not an audio file.');

  await dialog.locator('input[type=file]').setInputFiles({
    name: 'Kundemøde i Århus.wav',
    mimeType: 'audio/wav',
    buffer: wav(3),
  });
  await expect(dialog.getByLabel('Meeting title')).toHaveValue('Kundemøde i Århus');
  await settle(page);
  await page.screenshot({ path: shot('upload-dialog-1280') });
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kundemøde i Århus');
  await expect(page.getByRole('heading', { name: 'Transcribing' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play recording' })).toBeEnabled();
});

test('New meeting offers both ways; the dialog fits a phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/meetings');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await expect(page.getByRole('menuitem', { name: 'Record in the browser' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Upload a file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload audio' });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'Ugemøde.wav',
    mimeType: 'audio/wav',
    buffer: wav(2),
  });
  await settle(page);
  await page.screenshot({ path: shot('upload-dialog-390') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'New meeting' })).toBeFocused();
});

test('a reload mid-upload resumes with the same file', async ({ page, request }) => {
  // A two-chunk file whose first chunk reached the server before the "reload".
  const audio = wav(600);
  const name = 'Lang optagelse.wav';
  const created = await (
    await request.post('/api/v1/recordings', {
      headers: colleague,
      data: {
        meeting: { title: 'Lang optagelse', started_at: '2026-10-22T09:00:00Z' },
        duration_s: 600,
        sha256: sha256(audio),
        size_bytes: audio.length,
        source: 'upload',
        content_type: 'audio/wav',
      },
    })
  ).json();
  expect(created.chunk_count).toBe(2);
  await request.put(`/api/v1/recordings/${created.id}/chunks/1`, {
    headers: colleague,
    data: audio.subarray(0, 8 * 1024 * 1024),
  });

  await page.goto('/meetings');
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key!, value!),
    [
      `mtxt.upload:${name}:${audio.length}`,
      JSON.stringify({
        recording_id: created.id,
        meeting_id: created.meeting_id,
        sha256: sha256(audio),
        chunks_done: [1],
      }),
    ],
  );
  await page.getByRole('button', { name: 'Upload audio' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload audio' });
  await dialog
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: 'audio/wav', buffer: audio });
  await expect(dialog.getByText('This file was partly uploaded')).toBeVisible();
  await expect(dialog.getByText('1 of 2 chunks are on the server.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume' }).click();
  await expect(page).toHaveURL(new RegExp(`/meetings/${created.meeting_id}$`));
  const recording = await (
    await request.get(`/api/v1/recordings/${created.id}`, { headers: colleague })
  ).json();
  expect(recording.status).toBe('transcribing');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), `mtxt.upload:${name}:${audio.length}`),
  ).toBeNull();
});
