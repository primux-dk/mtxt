import { createHmac } from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { seal } from '../../../packages/adapters/src/secrets';
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
  wav,
} from './helpers';

/*
  Packet 13: outbound webhooks with consent. An admin adds an endpoint on
  the settings page and sees its secret once; the e2e build's receiver
  (lib/webhooks/fake-receiver.ts) records what the Worker posts. A company
  meeting goes out by itself after the transcript and after the recap; a
  private one only after its owner's "Send to Alex". The signed links work,
  and stop when the meeting turns private. A 500 is retried, Retry now
  sends at once, and the sixth failure parks the delivery. Meetings are the
  seeded colleague's, so the dev user's library keeps its 30.
*/
const KEY = 'ZTJlLXNldHRpbmdzLWtleS1ub3QtYS1zZWNyZXQtMDE='; // e2e/e2e.vars SETTINGS_KEY
const colleague = SESSION_HEADERS.colleague;
const RECEIVER = '/api/test/webhook-receiver';

type Attempt = {
  event: string;
  delivery: string;
  signature: string;
  body: string;
  answered: number;
};
type Delivery = { id: string; event: string; status: string; attempts: number };

let receiverUrl = '';
let secret = '';
let endpointId = '';

const receiver = (request: APIRequestContext, status: number) =>
  request.put(RECEIVER, { data: { status } });
const attemptsOf = async (request: APIRequestContext, deliveryId: string) => {
  const response = await request.get(`${RECEIVER}?delivery=${deliveryId}`);
  return response.ok() ? ((await response.json()) as Attempt[]) : [];
};
const deliveriesOf = (meetingId: string) =>
  d1<Delivery>(
    `select id, event, status, attempts from webhook_deliveries
     where meeting_id = '${meetingId}' order by created_at, id`,
  );
const testDeliveries = () =>
  d1<Delivery>(
    `select id, event, status, attempts from webhook_deliveries
     where event = 'webhook.test' and endpoint_id = '${endpointId}' order by created_at desc, id`,
  );

/** What a consumer does with the X-Mtxt-Signature header (README "Webhooks"). */
function verified(attempt: Attempt) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(attempt.signature) ?? [];
  if (!t || !v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${attempt.body}`).digest('hex');
  return expected === v1 && Math.abs(Date.now() / 1000 - Number(t)) < 300;
}

/** A meeting of the colleague with an 80-second recording, transcribed by the fake AssemblyAI, and its recap. */
async function drafted(request: APIRequestContext, title: string) {
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
  await expect
    .poll(
      () =>
        d1<{ n: number }>(
          `select count(*) as n from recap_versions v join recaps r on r.id = v.recap_id
           where r.meeting_id = '${meeting_id}'`,
        )[0]!.n,
      { timeout: 45_000 },
    )
    .toBe(1);
  return meeting_id as string;
}

const webhooksSection = (page: Page) => page.getByRole('region', { name: 'Webhooks' });

// A transcript and a recap draft take their time on the local queue.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(async ({ baseURL }) => {
  await signInHeaders(baseURL!);
  receiverUrl = `${baseURL}${RECEIVER}`;
  const key = await seal('e2e-assemblyai-key', 'settings.stt_api_key', KEY);
  d1(`update settings set stt_provider = 'assemblyai', stt_api_key = '${key}', language = 'auto',
      webhook_auto_send = 'off', default_visibility = 'private'`);
});

test.afterAll(() => {
  d1(`delete from webhook_deliveries; delete from webhook_endpoints;
      update settings set stt_provider = NULL, stt_api_key = NULL, webhook_auto_send = 'off',
        default_visibility = 'private'`);
});

test.beforeEach(async ({ context, request }) => {
  await asUser(context, 'dev');
  await receiver(request, 200);
  await request.post('/api/test/fake-recap/control', { data: { mode: 'completed' } });
  await request.post('/api/test/fake-assemblyai/control', {
    data: { mode: 'completed', delayMs: 500 },
  });
});

test('an admin turns on Send automatically and adds an endpoint; the secret shows once', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  const section = webhooksSection(page);
  await expect(section.getByText('No endpoints yet.')).toBeVisible();

  await section.getByLabel('Send automatically').selectOption('company');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(d1<{ v: string }>(`select webhook_auto_send as v from settings`)[0]!.v).toBe('company');

  await section.getByRole('button', { name: 'Add endpoint' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
  await expect(dialog).toBeVisible();
  // Rule 9: the errors sit at the field and keep what was typed.
  await dialog.getByLabel('URL').fill('http://alex.example.com/hooks');
  await dialog.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(dialog.getByText('Use an https URL.')).toBeVisible();
  await expect(dialog.getByLabel('URL')).toHaveValue('http://alex.example.com/hooks');
  await dialog.getByLabel('URL').fill('https://alex.example.com:8443/hooks');
  await dialog.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(dialog.getByText('Use the standard https port, 443.')).toBeVisible();
  await expect(dialog.getByText('https on port 443 only')).toBeVisible();
  await dialog.getByLabel('URL').fill('https://10.0.0.8/hooks');
  await dialog.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(dialog.getByText(/Refused: this is a local or private address/)).toBeVisible();
  await expect(dialog.getByLabel('URL')).toBeFocused();

  await dialog.getByLabel('Label').fill('Alex');
  await dialog.getByLabel('URL').fill(receiverUrl);
  await settle(page);
  await page.screenshot({ path: shot('webhook-add-1280') });
  await dialog.getByRole('button', { name: 'Add endpoint' }).click();

  const shown = page.getByRole('dialog', { name: 'Copy the signing secret' });
  await expect(shown).toBeVisible();
  secret = await shown.getByLabel('Signing secret').inputValue();
  expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  await settle(page);
  await page.screenshot({ path: shot('webhook-secret-1280') });
  await shown.getByRole('button', { name: 'Done' }).click();
  await expect(section.getByRole('button', { name: 'Add endpoint' })).toBeFocused();

  const rows = d1<{ id: string; secret: string; events: string }>(
    `select id, secret, events from webhook_endpoints`,
  );
  expect(rows).toHaveLength(1);
  endpointId = rows[0]!.id;
  // Sealed at rest, and never in the page again.
  expect(rows[0]!.secret).toMatch(/^v1\./);
  expect(JSON.parse(rows[0]!.events)).toHaveLength(5);
  await page.reload();
  expect(await page.content()).not.toContain(secret);
  await expect(webhooksSection(page).getByTestId('webhook-endpoint')).toContainText('Alex');
  await expect(webhooksSection(page).getByTestId('webhook-endpoint')).toContainText(
    'No deliveries yet',
  );
});

test('a 2 KB URL fits the list, and a disabled endpoint gets nothing', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  const section = webhooksSection(page);
  await section.getByRole('button', { name: 'Add endpoint' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
  const long = `https://crm.example.com/hooks/${'x'.repeat(2048 - 30)}`;
  expect(long).toHaveLength(2048);
  await dialog.getByLabel('Label').fill('CRM');
  await dialog.getByLabel('URL').fill(long);
  for (const name of ['Transcript ready', 'Recap drafted', 'Meeting shared', 'Meeting deleted'])
    await dialog.getByRole('checkbox', { name: new RegExp(name) }).uncheck();
  await dialog.getByRole('button', { name: 'Add endpoint' }).click();
  await page
    .getByRole('dialog', { name: 'Copy the signing secret' })
    .getByRole('button', { name: 'Done' })
    .click();
  // Disable is optimistic and holds after the server answers.
  await section.getByRole('button', { name: 'Disable CRM' }).click();
  await expect(section.getByRole('button', { name: 'Enable CRM' })).toBeVisible();
  await expect
    .poll(
      () =>
        d1<{ enabled: number }>(`select enabled from webhook_endpoints where label = 'CRM'`)[0]!
          .enabled,
    )
    .toBe(0);
  const card = section.getByTestId('webhook-endpoint').filter({ hasText: 'CRM' });
  // The long URL stays on one line inside the card; the log page shows it whole.
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThan(DESKTOP.width);
  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    await section.scrollIntoViewIfNeeded();
    await settle(page);
    await section.screenshot({ path: shot(`webhook-endpoints-${viewport.width}`) });
  }
});

test('keyboard only: add an endpoint, copy nothing, delete it, and focus lands where it should', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  const section = webhooksSection(page);
  const add = section.getByRole('button', { name: 'Add endpoint' });
  await add.focus();
  await expectFocusRing(add);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add endpoint' });
  await expect(dialog.getByLabel('Label')).toBeFocused();
  await page.keyboard.type('Tastatur');
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('URL')).toBeFocused();
  await page.keyboard.type(receiverUrl);
  // Space unticks the focused event; Enter in a field submits the dialog, not the settings form.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(dialog.getByRole('checkbox', { name: /Transcript ready/ })).not.toBeChecked();
  await dialog.getByLabel('URL').focus();
  await page.keyboard.press('Enter');
  const shown = page.getByRole('dialog', { name: 'Copy the signing secret' });
  await expect(shown.getByLabel('Signing secret')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  // The settings form was not submitted along the way.
  await expect(page.getByText('Settings saved.')).toHaveCount(0);

  const remove = section.getByRole('button', { name: 'Delete Tastatur' });
  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: 'Delete this endpoint?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Tastatur is deleted.')).toBeVisible();
  await expect(add).toBeFocused();
  expect(d1(`select id from webhook_endpoints where label = 'Tastatur'`)).toEqual([]);
});

test('rule 2: a refused Enable and Delete go back to what the server has', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  const section = webhooksSection(page);
  // Server actions post to the page's own URL; these never arrive.
  await page.route('**/settings', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await section.getByRole('button', { name: 'Enable CRM' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The change was not saved' }),
  ).toBeVisible();
  await expect(section.getByRole('button', { name: 'Enable CRM' })).toBeVisible();
  await section.getByRole('button', { name: 'Delete CRM' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this endpoint?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The endpoint could not be deleted' }),
  ).toBeVisible();
  await expect(section.getByTestId('webhook-endpoint').filter({ hasText: 'CRM' })).toBeVisible();
  await page.unroute('**/settings');
  expect(
    d1<{ enabled: number }>(`select enabled from webhook_endpoints where label = 'CRM'`),
  ).toEqual([{ enabled: 0 }]);
});

test('a company meeting goes out by itself after the transcript and after the recap, signed, without content', async ({
  request,
}) => {
  d1(`update settings set default_visibility = 'company'`);
  let meetingId = '';
  try {
    meetingId = await drafted(request, 'Webhook: produktionsmøde for hele firmaet');
  } finally {
    d1(`update settings set default_visibility = 'private'`);
  }
  await expect
    .poll(() => deliveriesOf(meetingId).map((d) => `${d.event}:${d.status}`), { timeout: 30_000 })
    .toEqual(['meeting.transcribed:delivered', 'recap.drafted:delivered']);
  const segment = d1<{ text: string }>(
    `select g.text from segments g join transcripts t on t.id = g.transcript_id
     join recordings r on r.id = t.recording_id where r.meeting_id = '${meetingId}' limit 1`,
  )[0]!.text;
  const recap = d1<{ body_md: string }>(
    `select body_md from recaps where meeting_id = '${meetingId}'`,
  )[0]!.body_md;
  for (const delivery of deliveriesOf(meetingId)) {
    const [attempt] = await attemptsOf(request, delivery.id);
    expect(attempt!.event).toBe(delivery.event);
    expect(verified(attempt!)).toBe(true);
    const payload = JSON.parse(attempt!.body);
    expect(Object.keys(payload).sort()).toEqual([
      'event',
      'expires_at',
      'install',
      'links',
      'meeting',
      'sent_at',
    ]);
    expect(payload.meeting).toMatchObject({
      id: meetingId,
      title: 'Webhook: produktionsmøde for hele firmaet',
      duration_s: 80,
      visibility: 'company',
      owner: { name: 'Jonas Skov', email: 'jonas.skov@example.com' },
    });
    // Metadata and links, never content.
    expect(attempt!.body).not.toContain(segment);
    expect(attempt!.body).not.toContain(recap.split('\n').find((l) => l.length > 20)!);
  }
  const audit = d1<{ action: string; details: string }>(
    `select action, details from audit_events where meeting_id = '${meetingId}' and action = 'webhook_sent' order by at`,
  );
  // The two deliveries run side by side; their audit rows come in either order.
  expect(
    audit.map((a) => JSON.parse(a.details)).sort((a, b) => a.event.localeCompare(b.event)),
  ).toEqual([
    { endpoint: 'Alex', event: 'meeting.transcribed' },
    { endpoint: 'Alex', event: 'recap.drafted' },
  ]);
});

test('the signed links fetch the transcript and the recap, and stop when the meeting turns private', async ({
  request,
  baseURL,
}) => {
  const meetingId = d1<{ id: string }>(
    `select id from meetings where title = 'Webhook: produktionsmøde for hele firmaet'`,
  )[0]!.id;
  const [transcribedDelivery, draftedDelivery] = deliveriesOf(meetingId);
  const transcribedPayload = JSON.parse(
    (await attemptsOf(request, transcribedDelivery!.id))[0]!.body,
  );
  const draftedPayload = JSON.parse((await attemptsOf(request, draftedDelivery!.id))[0]!.body);
  expect(draftedPayload.links.recap_markdown).toMatch(/\/api\/v1\/export\/v1\./);
  // No cookie: the link is the grant.
  const consumer = await playwrightRequest.newContext({ baseURL });
  try {
    const transcript = await consumer.get(transcribedPayload.links.transcript);
    expect(transcript.status()).toBe(200);
    const body = await transcript.json();
    expect(body.meeting_id).toBe(meetingId);
    expect(body.segments.length).toBeGreaterThan(0);
    const markdown = await consumer.get(draftedPayload.links.recap_markdown);
    expect(markdown.status()).toBe(200);
    expect(markdown.headers()['content-type']).toContain('text/markdown');
    const docx = await consumer.get(draftedPayload.links.recap_docx);
    expect(docx.status()).toBe(200);
    // One exact shape: no extra segment, no other method, no body, no 500 on a bare `%`.
    expect((await consumer.get(`${draftedPayload.links.recap_markdown}/extra`)).status()).toBe(404);
    const posted = await consumer.post(draftedPayload.links.recap_markdown, {
      data: Buffer.alloc(1024 * 1024),
    });
    expect(posted.status()).toBe(405);
    expect((await consumer.get('/api/v1/export/%25')).status()).toBe(404);
    // A link for one format does not open another.
    const swapped = draftedPayload.links.recap_markdown.replace('.md.', '.docx.');
    expect((await consumer.get(swapped)).status()).toBe(404);
    const audit = d1<{ user_id: string; details: string }>(
      `select user_id, details from audit_events where meeting_id = '${meetingId}' and action = 'exported' order by at`,
    );
    expect(audit.map((a) => JSON.parse(a.details))).toEqual([
      { format: 'transcript', via: 'webhook', endpoint: 'Alex' },
      { format: 'md', via: 'webhook', endpoint: 'Alex' },
      { format: 'docx', via: 'webhook', endpoint: 'Alex' },
    ]);
    // The owner makes it private: the same link answers as if there were nothing.
    d1(`update meetings set visibility = 'private' where id = '${meetingId}'`);
    expect((await consumer.get(transcribedPayload.links.transcript)).status()).toBe(404);
    expect((await consumer.get(draftedPayload.links.recap_markdown)).status()).toBe(404);
  } finally {
    await consumer.dispose();
  }
});

test('a private meeting is not sent until its owner sends it; a reader sees no action', async ({
  page,
  context,
  request,
}) => {
  const meetingId = await drafted(request, 'Webhook: lønsamtale, privat');
  // The automatic rule never covers private: nothing was queued, and nothing reached the receiver.
  await page.waitForTimeout(1500);
  expect(deliveriesOf(meetingId)).toEqual([]);

  await asUser(context, 'colleague');
  await page.setViewportSize(DESKTOP);
  await page.goto(`/meetings/${meetingId}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Send to Alex' })).toBeVisible();
  await settle(page);
  await page.screenshot({ path: shot('webhook-send-menu-1280') });
  await page.getByRole('menuitem', { name: 'Send to Alex' }).click();
  await expect(page.getByTestId('webhook-sent')).toHaveText('Alex gets this meeting now.');
  await expect
    .poll(() => deliveriesOf(meetingId).map((d) => `${d.event}:${d.status}`), { timeout: 30_000 })
    .toEqual(['meeting.transcribed:delivered', 'recap.drafted:delivered']);
  expect(
    d1<{ c: number | null }>(
      `select webhook_consent_at as c from meetings where id = '${meetingId}'`,
    )[0]!.c,
  ).not.toBeNull();
  // A second press sends nothing twice.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Send to Alex' }).click();
  await expect(page.getByTestId('webhook-sent')).toHaveText(/Alex has this meeting already/);
  expect(deliveriesOf(meetingId)).toHaveLength(2);

  // A company meeting of the colleague, opened by someone else: no owner menu, no action.
  d1(`update meetings set visibility = 'company' where id = '${meetingId}'`);
  await asUser(context, 'dev');
  await page.goto(`/meetings/${meetingId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('lønsamtale');
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  await expect(page.getByText('Send to Alex')).toHaveCount(0);
  // Private takes the consent back.
  d1(`update meetings set visibility = 'private' where id = '${meetingId}'`);
});

test('Send test event, a 500 retried by Retry now, and the delivery log', async ({
  page,
  request,
}) => {
  await receiver(request, 500);
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  await webhooksSection(page).getByRole('button', { name: 'Send a test event to Alex' }).click();
  await expect(page.getByText('A test event is on its way to Alex.')).toBeVisible();
  await expect
    .poll(
      () =>
        testDeliveries()[0] && `${testDeliveries()[0]!.status}:${testDeliveries()[0]!.attempts}`,
      {
        timeout: 20_000,
      },
    )
    .toBe('pending:1');
  const delivery = testDeliveries()[0]!;
  const [failed] = await attemptsOf(request, delivery.id);
  expect(failed!.answered).toBe(500);
  expect(JSON.parse(failed!.body)).toMatchObject({
    event: 'webhook.test',
    meeting: null,
    links: null,
  });
  expect(verified(failed!)).toBe(true);

  await page.getByRole('link', { name: 'Delivery log of Alex' }).click();
  await expect(page).toHaveURL(`/settings/webhooks/${endpointId}`);
  const row = page.getByTestId('webhook-log-row').first();
  await expect(row).toContainText('Test event');
  await expect(row).toContainText('Waiting to retry');
  await expect(row).toContainText('HTTP 500');
  await expect(row).toContainText('1 of 6');

  await receiver(request, 200);
  await row.getByRole('button', { name: /Retry now/ }).click();
  await expect(row.getByRole('status')).toHaveText(/Queued/);
  await expect(page.getByTestId('webhook-log-row').first()).toContainText('Delivered', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('webhook-log-row').first()).toContainText('2 of 6');
  const attempts = await attemptsOf(request, delivery.id);
  expect(attempts.map((a) => a.answered)).toEqual([500, 200]);
  // Both attempts carry the same delivery id, for the consumer's dedupe.
  expect(new Set(attempts.map((a) => a.delivery))).toEqual(new Set([delivery.id]));
});

test('the sixth failed attempt parks the delivery', async ({ page, request }) => {
  await receiver(request, 500);
  await page.setViewportSize(DESKTOP);
  await page.goto(`/settings/webhooks/${endpointId}`);
  // Send test event is the page's one primary action (rule 10).
  const send = page.getByRole('button', { name: 'Send test event' });
  await expect(send).toHaveCount(1);
  await expect(send).toHaveAttribute('data-variant', 'primary');
  await send.click();
  await expect.poll(() => testDeliveries()[0]?.attempts, { timeout: 20_000 }).toBe(1);
  const id = testDeliveries()[0]!.id;
  await page.reload();
  for (let attempt = 2; attempt <= 6; attempt++) {
    // No reload: once an attempt is made, the row comes back from the server with Retry now.
    const row = page.getByTestId('webhook-log-row').first();
    await expect(row).toContainText(`${attempt - 1} of 6`, { timeout: 20_000 });
    await expect(row.getByRole('status')).toHaveCount(0);
    await row.getByRole('button', { name: /Retry now/ }).click();
    await expect(row.getByRole('status')).toHaveText(/Queued/);
    await expect
      .poll(
        () => d1<Delivery>(`select attempts, status from webhook_deliveries where id = '${id}'`)[0],
        {
          timeout: 20_000,
        },
      )
      .toMatchObject({ attempts: attempt, status: attempt < 6 ? 'pending' : 'parked' });
  }
  const row = page.getByTestId('webhook-log-row').first();
  await expect(row).toContainText('Parked', { timeout: 20_000 });
  await expect(row).toContainText('6 of 6');
  await expect(row.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('A delivery gets six attempts, then it is parked.')).toBeVisible();
  // Parked is not the end: Retry now is still there.
  await expect(row.getByRole('button', { name: /Retry now/ })).toBeVisible();
  expect((await attemptsOf(request, id)).length).toBe(6);
});

test('the delivery log with 50 failed deliveries, at 1280 and 390', async ({ page }) => {
  // Rule 13: a full log of failures, written as fixtures beside the real rows.
  const now = Date.now();
  const values = Array.from({ length: 50 }, (_, i) => {
    const payload = JSON.stringify({
      event: 'recap.saved',
      meeting: { title: `Ugentligt driftsmøde ${i + 1}, Ærø og Langeland` },
    }).replaceAll("'", "''");
    return `('fixture-${i}', 'dev', '${endpointId}', 'recap.saved', null, '${payload}', 6,
      ${now}, 'parked', 500, 'http_status', ${now - i * 60_000}, null, ${now - i * 60_000})`;
  }).join(',\n');
  d1(`insert into webhook_deliveries (id, install_id, endpoint_id, event, meeting_id, payload, attempts,
      next_attempt_at, status, last_status_code, last_error, last_attempt_at, dedupe_key, created_at)
      values ${values}`);
  try {
    await page.goto(`/settings/webhooks/${endpointId}`);
    await expect(page.getByTestId('webhook-log-count')).toHaveText('50 deliveries');
    await expect(page.getByTestId('webhook-log-row')).toHaveCount(50);
    for (const viewport of [DESKTOP, PHONE]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await page.screenshot({ path: shot(`webhook-log-${viewport.width}`) });
    }
    // The add dialog on a phone.
    await page.goto('/settings');
    await webhooksSection(page).getByRole('button', { name: 'Add endpoint' }).click();
    await settle(page);
    await page.screenshot({ path: shot('webhook-add-390') });
  } finally {
    d1(`delete from webhook_deliveries where id like 'fixture-%'`);
  }
});

test('the delivery log says when it could not load', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/settings/webhooks/${endpointId}?state=failed`);
  await expect(page.getByRole('alert', { name: 'Could not load the delivery log' })).toContainText(
    'Check the connection',
  );
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('a non-admin gets the 403 page on a delivery log', async ({ context, page }) => {
  await asUser(context, 'colleague');
  const response = await page.goto(`/settings/webhooks/${endpointId}`);
  expect(response?.status()).toBe(403);
});
