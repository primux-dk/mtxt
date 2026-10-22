import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './contract';
import {
  asUser,
  DESKTOP,
  expectFocusRing,
  PHONE,
  settle,
  sha256,
  shot,
  wav,
  SESSION_HEADERS,
  signInHeaders,
} from './helpers';

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/*
  The meeting page, as the seeded colleague on meetings this spec makes
  through the API with a real WAV, so the player has audio. Rules 2
  (optimistic with rollback), 3 (archive and delete), 5 (?t=), 11
  (keyboard) and 10 (Export is the primary, disabled until packet 5).
*/
const colleague = SESSION_HEADERS.colleague;

async function meetingWithAudio(request: APIRequestContext, title: string) {
  const audio = wav(3);
  const created = await request.post('/api/v1/recordings', {
    headers: colleague,
    data: {
      meeting: { title, started_at: '2026-10-22T09:00:00Z' },
      duration_s: 3,
      sha256: sha256(audio),
      size_bytes: audio.length,
      source: 'upload',
      content_type: 'audio/wav',
    },
  });
  const { id, meeting_id } = await created.json();
  await request.put(`/api/v1/recordings/${id}/chunks/1`, { headers: colleague, data: audio });
  expect(
    (await request.post(`/api/v1/recordings/${id}/complete`, { headers: colleague })).status(),
  ).toBe(200);
  return meeting_id as string;
}

/** Makes every server action fail as if the connection dropped. */
async function dropActions(page: Page) {
  await page.route('**/meetings/**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort('connectionreset')
      : route.continue(),
  );
}

test.beforeEach(async ({ context }) => asUser(context, 'colleague'));

test('rename is optimistic, saved, and rolled back when the server does not get it', async ({
  page,
  request,
}) => {
  const id = await meetingWithAudio(request, 'Rename me');
  await page.goto(`/meetings/${id}`);
  await page.getByRole('button', { name: 'Rename meeting' }).click();
  await page.getByLabel('Meeting title').fill('Ugemøde med lageret');
  await page.getByLabel('Meeting title').press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ugemøde med lageret');
  await expect(page.getByRole('button', { name: 'Rename meeting' })).toBeFocused();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ugemøde med lageret');

  await dropActions(page);
  await page.getByRole('button', { name: 'Rename meeting' }).click();
  await page.getByLabel('Meeting title').fill('This never arrives');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('The title was not saved. It is back to the last saved title.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ugemøde med lageret');

  // An empty title is refused at the field and keeps the editor open.
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Rename meeting' }).click();
  await page.getByLabel('Meeting title').fill('  ');
  await page.getByLabel('Meeting title').press('Enter');
  await expect(page.getByText('Enter a title.')).toBeVisible();
  await page.getByLabel('Meeting title').press('Escape');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ugemøde med lageret');
});

test('Keep is optimistic and rolls back to the server state', async ({ page, request }) => {
  const id = await meetingWithAudio(request, 'Keep me');
  await page.goto(`/meetings/${id}`);
  const keep = page.getByRole('button', { name: 'Keep this meeting from automatic deletion' });
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
  );
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await saved;
  await page.reload();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');

  await dropActions(page);
  await keep.click();
  await expect(page.getByText('Keep was not saved. It is back as it was.')).toBeVisible();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
});

test('Keep clicked twice while the first request waits shows the server value', async ({
  page,
  request,
}) => {
  const id = await meetingWithAudio(request, 'Keep race');
  await page.goto(`/meetings/${id}`);
  const keep = page.getByRole('button', { name: 'Keep this meeting from automatic deletion' });
  // Hold the first action request, fail every later one.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  await page.route('**/meetings/**', async (route) => {
    if (route.request().method() !== 'POST' || !route.request().headers()['next-action']) {
      return route.continue();
    }
    calls++;
    if (calls === 1) {
      await held;
      return route.continue();
    }
    return route.abort('connectionreset');
  });
  // The review's case: two clicks while the first waits; the first succeeds, the second fails.
  await keep.click(); // wants true; request 1 is held
  await keep.click(); // wants false; sent once request 1 returns
  release();
  await expect(page.getByText('Keep was not saved. It is back as it was.')).toBeVisible();
  expect(calls).toBe(2);
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await page.unrouteAll();
  await page.reload();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
});

test('?t= opens the transcript tab with the player at that second', async ({ page, request }) => {
  const id = await meetingWithAudio(request, 'Seek me');
  await page.goto(`/meetings/${id}?t=2`);
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('player-time')).toHaveText('00:02');
  await expect(
    page.getByRole('slider', { name: 'Position in the recording, seconds' }),
  ).toHaveValue('2');
  await expect(page.getByRole('heading', { name: 'Transcribing' })).toBeVisible();

  // Out of range or not a whole number: ignored, and the page still works.
  for (const t of ['9'.repeat(400), '86401', '-5', '1.5']) {
    await page.goto(`/meetings/${id}?t=${t}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Seek me');
    await expect(page.getByTestId('player-time')).toHaveText('00:00');
  }
});

test('keyboard walk through the actions, the player and the tabs (rule 11)', async ({
  page,
  request,
}) => {
  const id = await meetingWithAudio(request, 'Walk me');
  await page.setViewportSize(DESKTOP);
  await page.goto(`/meetings/${id}`);
  await page.getByRole('link', { name: 'All meetings' }).focus();
  const order = [
    page.getByRole('button', { name: 'Rename meeting' }),
    page.getByRole('button', { name: 'Keep this meeting from automatic deletion' }),
    page.getByRole('button', { name: 'More actions' }),
    page.getByRole('button', { name: 'Play recording' }),
    page.getByRole('slider', { name: 'Position in the recording, seconds' }),
    page.getByRole('combobox', { name: 'Playback speed' }),
    page.getByRole('tab', { name: /Transcript/ }),
  ];
  for (const control of order) {
    await page.keyboard.press('Tab');
    await expectFocusRing(control);
  }
  // Tabs: arrows move between them, the panel follows.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Recap' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'No recap yet' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: /Transcript/ })).toBeFocused();

  // The player: Space plays and pauses, the arrows seek.
  await page.getByRole('button', { name: 'Play recording' }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause recording' })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Play recording' })).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('player-time')).toHaveText('00:01');

  // The overflow menu opens with Enter, walks with arrows, closes with Escape back to its button.
  const more = page.getByRole('button', { name: 'More actions' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Upload another recording' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();

  // Export is the primary action, disabled until packet 5, and says why.
  const exportButton = page.getByRole('button', { name: 'Export' });
  await expect(exportButton).toBeDisabled();
  await expect(exportButton).toHaveAccessibleDescription('Coming in packet 5');
});

test('archive leaves the library views; restore brings it back (rule 3)', async ({
  page,
  request,
}) => {
  const id = await meetingWithAudio(request, 'Arkivér mig');
  await page.goto(`/meetings/${id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(
    page.getByText('This meeting is archived. It is out of the library views.'),
  ).toBeVisible();

  await page.goto('/meetings?q=Arkiv%C3%A9r');
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
  await page.goto('/meetings?view=archived&q=Arkiv%C3%A9r');
  await expect(page.getByRole('link', { name: 'Arkivér mig' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore Arkivér mig' }).click();
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
  await page.goto('/meetings?q=Arkiv%C3%A9r');
  await expect(page.getByRole('link', { name: 'Arkivér mig' })).toBeVisible();
});

test('delete names what goes, then removes the meeting and its audio', async ({
  page,
  request,
}) => {
  const id = await meetingWithAudio(request, 'Delete me');
  await page.goto(`/meetings/${id}`);
  const audio = await page.locator('audio').getAttribute('src');
  const more = page.getByRole('button', { name: 'More actions' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this meeting?' });
  await expect(dialog).toContainText('Delete the meeting and 1 recording permanently.');
  await page.setViewportSize(DESKTOP);
  await settle(page);
  await page.screenshot({ path: shot('delete-dialog-1280') });
  // Cancel returns focus to the menu button.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(more).toBeFocused();

  await more.click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page).toHaveURL(/\/meetings$/);
  expect((await page.goto(`/meetings/${id}`))?.status()).toBe(404);
  expect((await request.get(audio!, { headers: colleague })).status()).toBe(404);
});

test('a reader sees a badge, no owner controls; a private meeting is not there at all', async ({
  page,
  context,
}) => {
  await asUser(context, 'dev');
  // The demo seed: the colleague's 0001 is shared with dev, 0002 company-wide, 0003 private.
  await page.goto('/meetings/demo-colleague-0001');
  await expect(page.getByText('Shared', { exact: true })).toBeVisible();
  await page.goto('/meetings/demo-colleague-0002');
  await expect(page.getByText('Company', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Keep this meeting from automatic deletion' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename meeting' })).toHaveCount(0);
  expect((await page.goto('/meetings/demo-colleague-0003'))?.status()).toBe(404);
});

for (const viewport of [DESKTOP, PHONE]) {
  test(`screenshot at ${viewport.width}`, async ({ page, request }) => {
    const id = await meetingWithAudio(request, 'Produktionsmøde, uge 43');
    await page.setViewportSize(viewport);
    await page.goto(`/meetings/${id}`);
    await expect(page.getByRole('heading', { name: 'Transcribing' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`meeting-${viewport.width}`), fullPage: true });
  });
}
