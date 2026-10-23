import { expect } from '@playwright/test';
import { test } from './contract';
import { daysAgo, dropActions, meetingWithAudio, r2Has } from './access-helpers';
import {
  asUser,
  d1,
  DESKTOP,
  PHONE,
  SESSION_HEADERS,
  settle,
  shot,
  signInHeaders,
} from './helpers';

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/*
  Retention (packet 6, behaviour rule 3): announced a week ahead with Keep,
  run nightly by the Cron Trigger, visible afterwards, never silent. The
  install keeps the defaults: audio 30 days, transcripts and recaps 365.
*/
const { colleague } = SESSION_HEADERS;

test.beforeEach(async ({ context }) => asUser(context, 'colleague'));

test('the notice comes 7 days ahead; Keep in it stops the deletion, and rolls back on failure', async ({
  page,
  request,
}) => {
  // Started 25 days ago: the audio falls due in 5 days.
  const { meetingId } = await meetingWithAudio(request, colleague, 'Snart slettet', daysAgo(25));
  const far = await meetingWithAudio(request, colleague, 'Langt fra', daysAgo(20));
  await page.goto(`/meetings/${far.meetingId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Langt fra');
  await expect(page.getByTestId('retention-notice')).toHaveCount(0);

  await page.goto(`/meetings/${meetingId}`);
  const notice = page.getByTestId('retention-notice');
  const due = new Date(Date.now() + 5 * 86_400_000);
  const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(due);
  await expect(notice).toContainText(`Will be deleted on ${day}`);
  const toggle = page.getByRole('button', { name: 'Keep this meeting from automatic deletion' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // Keep in the notice is the toggle's flag: both change, and it holds after a reload.
  await notice.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('Kept. Retention will not delete this meeting.')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => d1(`select keep from meetings where id = '${meetingId}'`))
    .toEqual([{ keep: 1 }]);
  await page.reload();
  await expect(page.getByText('Kept. Retention will not delete this meeting.')).toBeVisible();
  await toggle.click();
  await expect(notice).toBeVisible();
  await expect
    .poll(() => d1(`select keep from meetings where id = '${meetingId}'`))
    .toEqual([{ keep: 0 }]);

  // A Keep the server never gets comes back off, with the reason.
  await dropActions(page);
  await notice.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('Keep was not saved. It is back as it was.')).toBeVisible();
  await expect(notice).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.unroute('**/*');

  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    await page.reload();
    await expect(notice).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`retention-notice-${viewport.width}`) });
  }
});

test('the nightly job deletes audio from storage and the rows, in batches, and the library says so', async ({
  page,
  request,
  baseURL,
}) => {
  const old = await meetingWithAudio(request, colleague, 'Over et år gammelt', daysAgo(400));
  const kept = await meetingWithAudio(request, colleague, 'Gammelt men beholdt', daysAgo(400));
  d1(`update meetings set keep = 1 where id = '${kept.meetingId}'`);
  const [rec] = d1<{ storage_path: string }>(
    `select storage_path from recordings where id = '${old.recordingId}'`,
  );
  expect(r2Has(rec!.storage_path)).toBe(true);
  expect(
    (
      await request.get(`/api/v1/recordings/${old.recordingId}/audio`, { headers: colleague })
    ).status(),
  ).toBe(200);
  // 230 seeded meetings past both deadlines: three batches of at most 100.
  expect(
    d1(
      `select count(*) as n from meetings where owner_id = 'dev-archivist' and deleted_at is null`,
    ),
  ).toEqual([{ n: 230 }]);

  // wrangler dev --test-scheduled: this runs the Cron Trigger, which queues the first batch.
  const cron = await request.get(`${baseURL}/__scheduled?cron=${encodeURIComponent('0 3 * * *')}`);
  expect(cron.ok()).toBe(true);

  // The consumer runs batch after batch until the old meetings are all done.
  await expect
    .poll(
      () =>
        d1<{ n: number }>(
          `select count(*) as n from meetings where owner_id = 'dev-archivist' and deleted_at is null`,
        )[0]!.n,
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe(0);
  await expect
    .poll(() =>
      d1(
        `select storage_path, delete_audio_at is not null as dated from recordings where id = '${old.recordingId}'`,
      ),
    )
    .toEqual([{ storage_path: '', dated: 1 }]);
  expect(
    d1(`select deleted_at is not null as gone from meetings where id = '${old.meetingId}'`),
  ).toEqual([{ gone: 1 }]);
  expect(r2Has(rec!.storage_path)).toBe(false);
  expect(
    (
      await request.get(`/api/v1/recordings/${old.recordingId}/audio`, { headers: colleague })
    ).status(),
  ).toBe(404);
  // Keep stopped it.
  expect(d1(`select deleted_at from meetings where id = '${kept.meetingId}'`)).toEqual([
    { deleted_at: null },
  ]);
  const [keptRec] = d1<{ storage_path: string }>(
    `select storage_path from recordings where id = '${kept.recordingId}'`,
  );
  expect(r2Has(keptRec!.storage_path)).toBe(true);

  // Not silent: the owner's library shows the row, muted, with the date, until Remove.
  await page.goto('/meetings?q=Over%20et%20%C3%A5r');
  const row = page.locator('li[data-deleted]');
  await expect(row).toContainText('Over et år gammelt');
  await expect(row).toContainText('Deleted by retention on');
  await expect(row.getByRole('link')).toHaveCount(0);
  expect((await request.get(`/meetings/${old.meetingId}`, { headers: colleague })).status()).toBe(
    404,
  );
  await row.getByRole('button', { name: 'Remove Over et år gammelt from the library' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove this meeting?' });
  await expect(dialog).toContainText('Retention has already deleted the audio');
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No meetings match' })).toBeVisible();
  expect(d1(`select count(*) as n from meetings where id = '${old.meetingId}'`)).toEqual([
    { n: 0 },
  ]);
  expect(
    d1(
      `select count(*) as n from audit_events where action = 'deleted' and meeting_title = 'Over et år gammelt'`,
    ),
  ).toEqual([{ n: 1 }]);
});

test('retention removes the recap images of a meeting with no recording, transcript or recap', async ({
  request,
  baseURL,
}) => {
  const colleague = SESSION_HEADERS.colleague;
  d1(`delete from meetings where id = 'e2e-empty-images'`);
  d1(
    `insert into meetings (id, install_id, owner_id, title, title_folded, started_at, visibility)
     values ('e2e-empty-images', 'dev', 'dev-colleague', 'Tomt møde med billede', 'tomt møde med billede', ${daysAgo(400).getTime()}, 'private')`,
  );
  // A 1×1 PNG, uploaded by the owner into the empty meeting.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const uploaded = await request.post('/api/v1/meetings/e2e-empty-images/recap/images', {
    headers: { ...colleague, 'content-type': 'application/octet-stream' },
    data: png,
  });
  expect(uploaded.status()).toBe(201);
  const [image] = d1<{ path: string }>(
    `select path from recap_images where meeting_id = 'e2e-empty-images'`,
  );
  expect(r2Has(image!.path)).toBe(true);

  const cron = await request.get(`${baseURL}/__scheduled?cron=${encodeURIComponent('0 3 * * *')}`);
  expect(cron.ok()).toBe(true);
  await expect
    .poll(
      () =>
        d1<{ gone: number }>(
          `select deleted_at is not null as gone from meetings where id = 'e2e-empty-images'`,
        )[0]!.gone,
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(1);
  expect(r2Has(image!.path)).toBe(false);
  expect(
    d1(`select count(*) as n from recap_images where meeting_id = 'e2e-empty-images'`),
  ).toEqual([{ n: 0 }]);
});
