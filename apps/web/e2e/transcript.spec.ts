import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { open, seal } from '../../../packages/adapters/src/secrets';
import { test } from './contract';
import {
  asUser,
  d1,
  DESKTOP,
  expectFocusRing,
  PHONE,
  SESSION_HEADERS,
  settle,
  sha256,
  shot,
  signInHeaders,
  tabTo,
  wav,
} from './helpers';

/*
  Packet 4: a confirmed recording becomes a transcript with speakers. The
  install's provider is the e2e build's fake AssemblyAI (lib/stt/fake-providers.ts),
  which answers a submit and posts the webhook back after a short delay with
  a three-speaker Danish fixture; or the fake Workers AI; or the fake
  ElevenLabs, chosen on the settings page, with two speakers. Behaviour rules 2
  (rename and link, optimistic with rollback), 5 (timestamps put ?t= in the
  address), 8 and 9 (the transcript states and the failure's next steps),
  11 (keyboard, dialog focus) and 13 (the 4-hour, 14-speaker transcript).
  Meetings are made as the seeded colleague, so the dev user's library keeps
  its 30; the provider is set back to none afterwards for the specs that follow.
*/
const KEY = 'ZTJlLXNldHRpbmdzLWtleS1ub3QtYS1zZWNyZXQtMDE='; // e2e/e2e.vars SETTINGS_KEY
const colleague = SESSION_HEADERS.colleague;
const TERMS = ['linje 2', 'ugeplanen', 'Ærø'];

const control = (request: APIRequestContext, mode: 'completed' | 'error' | 'empty' | 'malformed') =>
  request.post('/api/test/fake-assemblyai/control', { data: { mode, delayMs: 1500 } });

async function useProvider(provider: 'assemblyai' | 'elevenlabs' | 'workers-ai-whisper') {
  const key =
    provider === 'workers-ai-whisper'
      ? null
      : await seal(`e2e-${provider}-key`, 'settings.stt_api_key', KEY);
  d1(
    `update settings set stt_provider = '${provider}', stt_api_key = ${key ? `'${key}'` : 'NULL'}, language = 'auto'`,
  );
}

/** A meeting with an 80-second WAV, uploaded and confirmed as the colleague. */
async function upload(request: APIRequestContext, title: string) {
  const audio = wav(80);
  const created = await request.post('/api/v1/recordings', {
    headers: colleague,
    data: {
      meeting: { title, started_at: '2026-10-22T09:00:00Z' },
      duration_s: 80,
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
  return { recordingId: id as string, meetingId: meeting_id as string };
}

async function statusOf(request: APIRequestContext, recordingId: string) {
  return (
    await (
      await request.get(`/api/v1/recordings/${recordingId}`, { headers: colleague }).then((r) => r)
    ).json()
  ).status as string;
}

/** Waits for the job, then opens the transcript tab. */
async function openTranscript(
  page: Page,
  request: APIRequestContext,
  ids: { recordingId: string; meetingId: string },
  end = 'transcribed',
) {
  await expect.poll(() => statusOf(request, ids.recordingId), { timeout: 30_000 }).toBe(end);
  await page.goto(`/meetings/${ids.meetingId}`);
  await page.getByRole('tab', { name: /Transcript/ }).click();
}

const segments = (page: Page) =>
  page.getByRole('list', { name: 'Transcript' }).getByRole('listitem');

/** Makes every server action fail as if the connection dropped. */
async function dropActions(page: Page) {
  await page.route('**/meetings/**', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort('connectionreset')
      : route.continue(),
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  await signInHeaders(baseURL!);
  await useProvider('assemblyai');
  d1(
    `insert or ignore into keyterms (id, install_id, term, boost) values ${TERMS.map((t, i) => `('e2e-term-${i}', 'dev', '${t}', 1)`).join(', ')}`,
  );
});

test.afterAll(() => {
  d1(`update settings set stt_provider = NULL, stt_api_key = NULL`);
  d1(`delete from keyterms where id like 'e2e-term-%'`);
});

test.beforeEach(async ({ context, request }) => {
  await asUser(context, 'colleague');
  await control(request, 'completed');
});

test('upload, confirm, transcribing, webhook, transcribed: segments, speakers and keyterms show', async ({
  page,
  request,
  baseURL,
}) => {
  const ids = await upload(request, 'Transskriberet møde');
  await page.goto(`/meetings/${ids.meetingId}`);
  await expect(page.getByText('Transcribing with AssemblyAI (EU).')).toBeVisible();

  // The webhook brings it in; the page looks again by itself.
  await expect(segments(page)).toHaveCount(5, { timeout: 30_000 });
  expect(await statusOf(request, ids.recordingId)).toBe('transcribed');
  await expect(page.getByText('Danish · 3 speakers · Click a speaker to rename')).toBeVisible();
  await expect(segments(page).first()).toContainText('Speaker 1');
  await expect(segments(page).nth(1)).toContainText('Speaker 2');
  await expect(segments(page).nth(2)).toContainText('Speaker 3');

  // Keyterms are marked as whole words; "planen" inside a longer word is not.
  const marks = page.locator('mark');
  await expect(marks).toHaveText(['linje 2', 'ugeplanen', 'Ærø']);

  // What the fake AssemblyAI was asked for.
  const sent = await (await request.get('/api/test/fake-assemblyai/control')).json();
  expect(sent).toMatchObject({
    speech_models: ['universal-3-5-pro', 'universal-2'],
    speaker_labels: true,
    language_detection: true,
    webhook_url: `${baseURL}/api/v1/webhooks/assemblyai`,
    webhook_auth_header_name: 'X-Mtxt-Webhook-Secret',
  });
  expect(sent.keyterms_prompt).toEqual(expect.arrayContaining(TERMS));
  await expect
    .poll(() =>
      d1(`select count(*) as n from transcripts where recording_id = '${ids.recordingId}'`),
    )
    .toEqual([{ n: 1 }]);
});

test('the webhook: a wrong secret is 401, a replay is acknowledged and ignored', async ({
  playwright,
  baseURL,
}) => {
  const [row] = d1<{ webhook_secret: string }>(`select webhook_secret from settings`);
  const secret = await open(row!.webhook_secret, 'settings.webhook_secret', KEY);
  const [done] = d1<{ provider_job_id: string }>(
    `select provider_job_id from transcripts where provider = 'assemblyai' and status = 'done' and provider_job_id like 'fake-%' limit 1`,
  );
  // No session cookie: the webhook stands on its secret alone.
  const anonymous = await playwright.request.newContext({ baseURL });
  const post = (header: string) =>
    anonymous.post('/api/v1/webhooks/assemblyai', {
      headers: { 'X-Mtxt-Webhook-Secret': header },
      data: { transcript_id: done!.provider_job_id, status: 'completed' },
    });
  expect((await post('wrong')).status()).toBe(401);
  const replay = await post(secret);
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual({ ok: true, ignored: true });
  await anonymous.dispose();
});

test('a timestamp seeks the player and puts ?t= in the address without a navigation', async ({
  page,
  request,
}) => {
  const ids = await upload(request, 'Spol i mødet');
  await openTranscript(page, request, ids);
  const before = await page.evaluate(() => window.history.length);
  await page.getByRole('button', { name: 'Go to 00:36' }).click();
  await expect(page).toHaveURL(/\?t=36$/);
  await expect(page.getByTestId('player-time')).toHaveText('00:36');
  await expect(segments(page).nth(2)).toHaveAttribute('aria-current', 'time');
  expect(await page.evaluate(() => window.history.length)).toBe(before);

  // The link opens there: the player at 00:49 and its segment marked.
  await page.goto(`/meetings/${ids.meetingId}?t=49`);
  await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(segments(page).nth(3)).toHaveAttribute('aria-current', 'time');
});

test('a typed name survives the playhead moving while audio plays', async ({ page, request }) => {
  const ids = await upload(request, 'Navn under afspilning');
  await openTranscript(page, request, ids);
  await page.getByRole('button', { name: 'Play recording' }).click();
  await expect(page.getByTestId('player-time')).not.toHaveText('00:00');
  await page
    .getByRole('button', { name: 'Speaker 2, rename or link to a colleague' })
    .first()
    .click();
  const name = page
    .getByRole('dialog', { name: 'Rename speaker' })
    .getByLabel('Name', { exact: true });
  await name.fill('Søren');
  const before = await page.getByTestId('player-time').textContent();
  // Several playhead updates go by; the draft stays.
  await expect(page.getByTestId('player-time')).not.toHaveText(before!, { timeout: 5000 });
  await page.waitForTimeout(1500);
  await expect(name).toHaveValue('Søren');
});

test('rename a speaker: every line changes at once, and a refused save rolls back', async ({
  page,
  request,
}) => {
  const ids = await upload(request, 'Omdøb en taler');
  await openTranscript(page, request, ids);
  await page
    .getByRole('button', { name: 'Speaker 3, rename or link to a colleague' })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rename speaker' });
  await dialog.getByLabel('Name', { exact: true }).fill('Søren Bak');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(segments(page).nth(2)).toContainText('Søren Bak');
  await expect(segments(page).nth(4)).toContainText('Søren Bak');
  await page.reload();
  await page.getByRole('tab', { name: /Transcript/ }).click();
  await expect(segments(page).nth(4)).toContainText('Søren Bak');

  await dropActions(page);
  await page
    .getByRole('button', { name: 'Søren Bak, rename or link to a colleague' })
    .first()
    .click();
  await dialog.getByLabel('Name', { exact: true }).fill('Forkert navn');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'speaker' })).toHaveText(
    'The speaker was not changed. It is back as it was.',
  );
  await expect(segments(page).nth(2)).toContainText('Søren Bak');
  await expect(page.getByText('Forkert navn')).toHaveCount(0);
  await page.unroute('**/meetings/**');
  await expect
    .poll(() =>
      d1(`select label from speakers where meeting_id = '${ids.meetingId}' and speaker_index = 2`),
    )
    .toEqual([{ label: 'Søren Bak' }]);
});

test('link a speaker to a colleague, and unlink', async ({ page, request }) => {
  const ids = await upload(request, 'Tilknyt en kollega');
  await openTranscript(page, request, ids);
  await page
    .getByRole('button', { name: 'Speaker 1, rename or link to a colleague' })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rename speaker' });
  await dialog.getByLabel('Search colleagues').fill('ANNE');
  await dialog.getByRole('button', { name: 'Link to Anne Holm, anne.holm@example.com' }).click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Anne Holm');
  await expect(dialog.getByText('Linked to Anne Holm')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(segments(page).first()).toContainText('AHAnne Holm');
  await expect
    .poll(() =>
      d1(
        `select label, user_id from speakers where meeting_id = '${ids.meetingId}' and speaker_index = 0`,
      ),
    )
    .toEqual([{ label: 'Anne Holm', user_id: 'dev-newcomer' }]);

  await page
    .getByRole('button', { name: 'Anne Holm, rename or link to a colleague' })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Unlink' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      d1(
        `select user_id from speakers where meeting_id = '${ids.meetingId}' and speaker_index = 0`,
      ),
    )
    .toEqual([{ user_id: null }]);
  await expect(segments(page).first()).toContainText('Anne Holm');
});

test('a failed transcription says why, with Try again for the owner and Switch provider for an admin', async ({
  page,
  request,
  browser,
}) => {
  await control(request, 'error');
  const ids = await upload(request, 'Fejlet transskription');
  await expect.poll(() => statusOf(request, ids.recordingId), { timeout: 30_000 }).toBe('failed');
  await page.goto(`/meetings/${ids.meetingId}`);
  const alert = page.getByRole('alert').filter({ hasText: 'Transcription failed' });
  await expect(alert.getByRole('heading', { name: 'Transcription failed' })).toBeVisible();
  await expect(alert).toContainText('AssemblyAI (EU) could not transcribe the recording.');
  await expect(alert).toContainText('Reason: The provider could not read the audio.');
  // The provider's own words never reach the page or the row.
  await expect(alert).not.toContainText('Fake AssemblyAI');
  await expect
    .poll(() => d1(`select failure_reason from recordings where id = '${ids.recordingId}'`))
    .toEqual([{ failure_reason: 'bad_audio' }]);
  await expect(alert).toContainText('To switch provider, ask an admin.');
  await expect(alert.getByRole('link', { name: 'Switch provider' })).toHaveCount(0);
  await settle(page);
  await page.setViewportSize(DESKTOP);
  await page.screenshot({ path: shot('transcript-failed-1280'), fullPage: true });

  // An admin who may read the meeting gets the link to Settings, not Try again.
  d1(`update meetings set visibility = 'company' where id = '${ids.meetingId}'`);
  const admin = await browser.newContext();
  await asUser(admin, 'dev');
  const adminPage = await admin.newPage();
  await adminPage.goto(`/meetings/${ids.meetingId}`);
  await expect(adminPage.getByRole('link', { name: 'Switch provider' })).toHaveAttribute(
    'href',
    '/settings#stt',
  );
  await expect(adminPage.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await admin.close();

  // Try again queues it once more; this time the provider answers.
  await control(request, 'completed');
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Transcribing with AssemblyAI (EU).')).toBeVisible();
  await expect(segments(page)).toHaveCount(5, { timeout: 30_000 });
});

test('a malformed provider answer that echoes the key: no key in the Worker output or the rows', async ({
  request,
}) => {
  await control(request, 'malformed');
  const ids = await upload(request, 'Ødelagt svar');
  await expect.poll(() => statusOf(request, ids.recordingId), { timeout: 30_000 }).toBe('failed');
  await expect
    .poll(() => d1(`select failure_reason from recordings where id = '${ids.recordingId}'`))
    .toEqual([{ failure_reason: 'provider_error:200' }]);
  const log = readFileSync('.wrangler/e2e-worker.log', 'utf8');
  expect(log).toContain('The transcribe job failed; retrying');
  expect(log).not.toContain('e2e-assemblyai-key');
  expect(JSON.stringify(d1('select * from recordings'))).not.toContain('e2e-assemblyai-key');
});

test('no speech: the transcript is empty and says so', async ({ page, request }) => {
  await control(request, 'empty');
  const ids = await upload(request, 'Ingen tale');
  await openTranscript(page, request, ids);
  await expect(page.getByRole('heading', { name: 'No speech was found' })).toBeVisible();
});

test('Workers AI Whisper: one speaker, synchronous', async ({ page, request }) => {
  await useProvider('workers-ai-whisper');
  try {
    const ids = await upload(request, 'Whisper-møde');
    await openTranscript(page, request, ids);
    await expect(segments(page)).toHaveCount(2);
    await expect(page.getByText('Danish · 1 speaker · Click a speaker to rename')).toBeVisible();
    await expect(segments(page).first()).toContainText('Speaker 1');
    await expect(page.locator('mark').first()).toHaveText('linje 2');
    await expect
      .poll(() =>
        d1(`select provider, model from transcripts where recording_id = '${ids.recordingId}'`),
      )
      .toEqual([{ provider: 'workers-ai-whisper', model: '@cf/openai/whisper-large-v3-turbo' }]);
  } finally {
    await useProvider('assemblyai');
  }
});

test('ElevenLabs Scribe, chosen in Settings: two speakers, synchronous, from one multipart request', async ({
  page,
  request,
  browser,
}) => {
  const admin = await browser.newContext();
  try {
    // An admin chooses it on the settings page; the panel says the route and the residency.
    await asUser(admin, 'dev');
    const settings = await admin.newPage();
    await settings.goto('/settings');
    const gateway = await settings.locator('#aiGatewayId').inputValue();
    await settings.locator('#sttProvider').selectOption('elevenlabs');
    await expect(settings.locator('#sttRegion')).toHaveCount(0);
    const panel = settings.getByRole('complementary', { name: 'Data flow' });
    await settings.locator('#aiGatewayId').fill('');
    await expect(panel).toContainText(
      'No AI Gateway ID is set, so ElevenLabs Scribe receives audio and keyterms directly. It returns text and speakers.',
    );
    await settings.locator('#aiGatewayId').fill('mtxt-gateway');
    await expect(panel).toContainText(
      'ElevenLabs Scribe receives audio and keyterms through AI Gateway',
    );
    await expect(panel).toContainText(
      'On a self-serve ElevenLabs plan, ElevenLabs processes the audio in the US',
    );
    await settings.locator('#aiGatewayId').fill(gateway);
    await settings.locator('#sttApiKey').fill('e2e-elevenlabs-key');
    await settings.getByRole('button', { name: 'Save settings' }).click();
    await expect(settings.getByText('Settings saved.')).toBeVisible();
    await expect
      .poll(() => d1(`select stt_provider, stt_region from settings`))
      .toEqual([{ stt_provider: 'elevenlabs', stt_region: null }]);

    const ids = await upload(request, 'Scribe-møde');
    await openTranscript(page, request, ids);
    await expect(segments(page)).toHaveCount(4);
    await expect(page.getByText('Danish · 2 speakers · Click a speaker to rename')).toBeVisible();
    await expect(segments(page).nth(0)).toContainText('Speaker 1');
    await expect(segments(page).nth(0)).toContainText('Lad os tage linje 2 først.');
    await expect(segments(page).nth(1)).toContainText('Speaker 2');
    // Two segments of the second speaker: a 2.1 s pause between them.
    await expect(segments(page).nth(2)).toContainText('Ugeplanen holder.');
    await expect(page.locator('mark')).toHaveText(['linje 2', 'Ugeplanen', 'Ærø']);
    await expect
      .poll(() =>
        d1(`select provider, model from transcripts where recording_id = '${ids.recordingId}'`),
      )
      .toEqual([{ provider: 'elevenlabs', model: 'scribe_v2' }]);

    // What the fake ElevenLabs was sent: the whole file, with a length, and the fields.
    const sent = await (await request.get('/api/test/fake-elevenlabs/control')).json();
    expect(sent).toMatchObject({
      model_id: 'scribe_v2',
      diarize: 'true',
      timestamps_granularity: 'word',
      tag_audio_events: 'false',
      file: { bytes: wav(80).length, type: 'audio/wav', name: 'recording.wav' },
    });
    expect(sent.language_code).toBeUndefined();
    expect(sent.keyterms).toEqual(expect.arrayContaining(TERMS));
    expect(Number(sent.contentLength)).toBeGreaterThan(wav(80).length);
  } finally {
    await admin.close();
    await useProvider('assemblyai');
  }
});

test('ElevenLabs failure: a fixed reason with the status, and the key echoed in the body reaches no log or row', async ({
  page,
  request,
}) => {
  await useProvider('elevenlabs');
  try {
    await control(request, 'error');
    const ids = await upload(request, 'Scribe fejler');
    await expect.poll(() => statusOf(request, ids.recordingId), { timeout: 30_000 }).toBe('failed');
    await expect
      .poll(() =>
        d1(`select failure, failure_reason from recordings where id = '${ids.recordingId}'`),
      )
      .toEqual([{ failure: 'stt_failed', failure_reason: 'bad_audio:422' }]);
    await page.goto(`/meetings/${ids.meetingId}`);
    const alert = page.getByRole('alert').filter({ hasText: 'Transcription failed' });
    await expect(alert).toContainText('ElevenLabs Scribe could not transcribe the recording.');
    await expect(alert).toContainText('Reason: The provider could not read the audio (HTTP 422).');
    await expect(alert).not.toContainText('Fake ElevenLabs');
    const log = readFileSync('.wrangler/e2e-worker.log', 'utf8');
    expect(log).toContain('Transcription failed');
    expect(log).not.toContain('e2e-elevenlabs-key');
    expect(JSON.stringify(d1('select * from recordings'))).not.toContain('e2e-elevenlabs-key');
    expect(JSON.stringify(d1('select * from transcripts'))).not.toContain('e2e-elevenlabs-key');
  } finally {
    await useProvider('assemblyai');
  }
});

test('keyboard: tab, speaker dialog with focus kept and returned, timestamp by Enter', async ({
  page,
  request,
}) => {
  const ids = await upload(request, 'Tastaturet');
  await openTranscript(page, request, ids);
  const speaker = page
    .getByRole('button', { name: 'Speaker 2, rename or link to a colleague' })
    .first();
  await page.getByRole('tab', { name: /Transcript/ }).focus();
  await tabTo(page, speaker);
  await expectFocusRing(speaker);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Rename speaker' });
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(speaker).toBeFocused();

  const stamp = page.getByRole('button', { name: 'Go to 00:18' });
  await page.keyboard.press('Tab');
  await expect(stamp).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?t=18$/);
});

test('a reader sees speaker labels, not buttons', async ({ request, browser }) => {
  const ids = await upload(request, 'Til hele firmaet');
  await expect
    .poll(() => statusOf(request, ids.recordingId), { timeout: 30_000 })
    .toBe('transcribed');
  d1(`update meetings set visibility = 'company' where id = '${ids.meetingId}'`);
  const reader = await browser.newContext();
  await asUser(reader, 'newcomer');
  const readerPage = await reader.newPage();
  await readerPage.goto(`/meetings/${ids.meetingId}`);
  // Packet 5: a transcribed meeting gets its recap, and the recap tab opens first.
  await readerPage.getByRole('tab', { name: /Transcript/ }).click();
  await expect(segments(readerPage)).toHaveCount(5);
  await expect(readerPage.getByText('Danish · 3 speakers', { exact: true })).toBeVisible();
  await expect(readerPage.getByRole('button', { name: /rename or link/ })).toHaveCount(0);
  await expect(segments(readerPage).first()).toContainText('Speaker 1');
  await reader.close();
});

test.describe('the seeded library, as the dev user', () => {
  test.beforeEach(async ({ context }) => asUser(context, 'dev'));

  test('the library shows who spoke and Ready', async ({ page }) => {
    await page.goto('/meetings');
    const row = page.getByRole('listitem').filter({ hasText: 'Produktionsmøde, uge 43' });
    await expect(row).toContainText('Mette, Jonas and 2 others');
    await expect(row).toContainText('Ready');
    const day = page.getByRole('listitem').filter({ hasText: 'Strategidag, hele dagen' });
    await expect(day).toContainText('Mette, Speaker 2 and 12 others');
  });

  test('a 4-hour transcript of 6,000 segments keeps a few hundred in the page', async ({
    page,
  }) => {
    await page.goto('/meetings/demo-0002?t=7200');
    await expect(page.getByRole('button', { name: 'Go to 2:00:00' })).toBeInViewport();
    expect(await segments(page).count()).toBeLessThanOrEqual(400);
    await expect(page.getByText(/^Showing 2:00:\d\d of 4:00:00$/)).toBeVisible();
    // The last block renders after the scroll stops; the position follows without another scroll.
    await page.keyboard.press('End');
    await expect(page.getByText(/^Showing 3:59:\d\d of 4:00:00$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to 3:59:57' })).toBeVisible();
    expect(await segments(page).count()).toBeLessThanOrEqual(400);
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`transcript screenshot at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/meetings/demo-0000');
      await page.getByRole('tab', { name: /Transcript/ }).click();
      await expect(page.locator('mark').first()).toHaveText('linje 2');
      await settle(page);
      await page.screenshot({ path: shot(`transcript-${viewport.width}`) });
    });
  }
});
