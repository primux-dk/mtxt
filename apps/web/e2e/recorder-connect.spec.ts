import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './contract';
import {
  d1,
  DESKTOP,
  expectFocusRing,
  PHONE,
  settle,
  sha256,
  shot,
  signIn,
  tabTo,
  USERS,
  wav,
} from './helpers';

/*
  Packet 8: a desktop recorder connects through the browser (docs/spec.md
  "Recorder connection"). A scripted "recorder" makes a verifier, opens
  /connect, polls the token endpoint and then uses the API with its bearer
  token. Every /api/v1 response is checked against the contract.
*/
const LONE = { email: 'lone.berg@example.com', name: 'Lone Berg', admin: false };
const RASMUS = { email: 'rasmus.krogh@example.com', name: 'Rasmus Krogh', admin: false };
/** Rule 13: the longest device name the page takes. */
const LONG_NAME = 'Konferencerummet på 2. sal, bygning C, Æblehaven 14, Åbenrå 6200';

/** The pairing code as the contract derives it (x-recorder-flow.pairing_code). */
function pairing(challenge: string) {
  const bits = createHash('sha256').update(challenge, 'ascii').digest().readUInt32BE(0) >>> 2;
  const code = [25, 20, 15, 10, 5, 0]
    .map((shift) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[(bits >>> shift) & 31])
    .join('');
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const connectUrl = (challenge: string, name: string) =>
  `/connect?${new URLSearchParams({ challenge, name })}`;

const poll = (request: APIRequestContext, body: { challenge: string; verifier: string }) =>
  request.post('/api/v1/recorder/token', { data: body });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Opens Recorders from the user slot: the sidebar on a desktop, the menu sheet on a phone. */
async function openRecorders(page: Page) {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 720) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'Recorders', exact: true }).last().click();
  return page.getByRole('dialog', { name: 'Recorders' });
}

test.describe.configure({ mode: 'serial' });

test('signed out, connect, sign in, approve; the recorder polls, uploads, and Disconnect revokes it', async ({
  page,
  context,
  request,
}) => {
  const { verifier, challenge } = pkce();
  const device = 'Lones MacBook Pro';

  // Signed out: the login page, with the way back to /connect.
  await page.goto(connectUrl(challenge, device));
  await expect(page).toHaveURL(/\/login\?/);
  const back = new URL(page.url()).searchParams.get('callbackUrl')!;
  expect(back).toBe(connectUrl(challenge, device));

  // The recorder already polls: nothing approved yet.
  const waiting = await poll(request, { challenge, verifier });
  expect(waiting.status()).toBe(202);
  expect(waiting.headers()['retry-after']).toBe('2');

  // Sign in (the e2e build's sign-in stands in for OIDC) and come back.
  await signIn(context.request, LONE);
  await page.goto(back);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    new RegExp(`^Connect ${device} to .+\\?$`),
  );
  await expect(page.getByText('Signed in as')).toBeVisible();
  // The pairing code the recorder shows too, and the warning above the buttons.
  await expect(page.getByTestId('pairing-code')).toHaveText(
    `Pairing code ${pairing(challenge)}. It must match the code your recorder shows.`,
  );
  await expect(
    page.getByText(
      'Only approve a connection you just started in your own recorder. If you did not, press Cancel.',
    ),
  ).toBeVisible();
  await expect(page.getByText(LONE.email)).toBeVisible();
  // Rule 10: Approve is the one primary.
  await expect(page.locator('[data-variant="primary"]')).toHaveCount(1);
  await expect(page.locator('[data-variant="primary"]')).toHaveText('Approve');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();

  // The recorder receives its token once, with the branding.
  const granted = await poll(request, { challenge, verifier });
  expect(granted.status()).toBe(200);
  const body = (await granted.json()) as {
    token: string;
    token_id: string;
    device_name: string;
    user: { id: string; name: string; email: string };
    install: { product_name: string; theme_accent: string };
  };
  expect(body.device_name).toBe(device);
  expect(body.user.name).toBe(LONE.name);
  expect(body.user.email).toBe(LONE.email);
  expect(body.user.id).toBeTruthy();
  expect(body.install.theme_accent).toMatch(/^#[0-9a-f]{6}$/i);
  const [stored] = d1<{ token_hash: string; user_email: string }>(
    `select t.token_hash, u.email as user_email from recorder_tokens t join users u on u.id = t.user_id where t.id = '${body.token_id}'`,
  );
  expect(stored).toEqual({
    token_hash: createHash('sha256').update(body.token).digest('hex'),
    user_email: LONE.email,
  });

  // With the bearer token alone (no cookie), create a recording and upload its one chunk.
  const file = wav(1);
  const created = await request.post('/api/v1/recordings', {
    headers: bearer(body.token),
    data: {
      meeting: { title: 'Connected recorder test', started_at: new Date().toISOString() },
      duration_s: 1,
      source: 'desktop',
      content_type: 'audio/wav',
      sha256: sha256(file),
      size_bytes: file.length,
    },
  });
  expect(created.status()).toBe(201);
  const recording = (await created.json()) as { id: string; meeting_id: string };
  const chunk = await request.put(`/api/v1/recordings/${recording.id}/chunks/1`, {
    headers: { ...bearer(body.token), 'content-type': 'application/octet-stream' },
    data: file,
  });
  expect(chunk.status()).toBe(200);
  const complete = await request.post(`/api/v1/recordings/${recording.id}/complete`, {
    headers: bearer(body.token),
  });
  expect(complete.status()).toBe(200);
  await expect
    .poll(() =>
      d1(
        `select u.email from meetings m join users u on u.id = m.owner_id where m.id = '${recording.meeting_id}'`,
      ),
    )
    .toEqual([{ email: LONE.email }]);

  // The page now says it is connected; a reload never asks again.
  await page.reload();
  await expect(page.getByRole('heading', { name: `${device} is connected` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // Recorders lists it with its last use; Disconnect revokes it.
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  const dialog = await openRecorders(page);
  const list = dialog.getByTestId('recorders-list');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText(device)).toBeVisible();
  await expect(list.getByText(/^Connected .+ · last used .+$/)).toBeVisible();
  await dialog.getByRole('button', { name: `Disconnect ${device}` }).click();
  await expect(dialog.getByText('No recorders connected')).toBeVisible();
  await expect
    .poll(() =>
      d1(
        `select revoked_at is not null as revoked from recorder_tokens where id = '${body.token_id}'`,
      ),
    )
    .toEqual([{ revoked: 1 }]);

  // The next call with the token is 401 in the contract's shape, not a login redirect.
  const refused = await request.get(`/api/v1/recordings/${recording.id}`, {
    headers: bearer(body.token),
    maxRedirects: 0,
  });
  expect(refused.status()).toBe(401);
  expect((await refused.json()).error.code).toBe('unauthorized');

  // The audit log has both, with the device and no meeting.
  await expect
    .poll(() =>
      d1(
        `select a.action, a.meeting_id, a.details from audit_events a join users u on u.id = a.user_id
       where u.email = '${LONE.email}' and a.action like 'recorder_%' order by a.at`,
      ),
    )
    .toEqual([
      { action: 'recorder_connected', meeting_id: null, details: `{"device":"${device}"}` },
      { action: 'recorder_disconnected', meeting_id: null, details: `{"device":"${device}"}` },
    ]);
  // The token never reaches the Worker's log.
  expect(readFileSync('.wrangler/e2e-worker.log', 'utf8')).not.toContain(body.token);
});

test('a wrong verifier, Cancel and an expired grant get 410 and a next step; a fast poll gets 429', async ({
  page,
  context,
  request,
}) => {
  await signIn(context.request, LONE);

  // A wrong verifier is 410 at once; the grant itself still works with the right one.
  const first = pkce();
  await page.goto(connectUrl(first.challenge, 'Lones iMac'));
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
  const wrong = await poll(request, { challenge: first.challenge, verifier: pkce().verifier });
  expect(wrong.status()).toBe(410);
  expect((await wrong.json()).error.code).toBe('denied');
  const right = await poll(request, first);
  expect(right.status()).toBe(200);
  const { token, token_id } = (await right.json()) as { token: string; token_id: string };

  // Cancel: the page says what to do next; the recorder gets 410 denied, from one read each time.
  const second = pkce();
  await page.goto(connectUrl(second.challenge, 'Lones iMac'));
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Not connected' })).toBeVisible();
  await expect(page.getByText('Open the recorder and connect again.')).toBeVisible();
  const denied = await poll(request, second);
  expect(denied.status()).toBe(410);
  expect((await denied.json()).error.code).toBe('denied');
  expect((await poll(request, second)).status()).toBe(410);

  // An approved grant polled twice inside a second: 429 with Retry-After, no token.
  const busy = pkce();
  await page.goto(connectUrl(busy.challenge, 'Lones iMac'));
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
  // A poll just let through, as the database sees it (set ahead: the d1 call itself takes over a second).
  d1(
    `update recorder_grants set last_poll_at = ${Date.now() + 30_000} where challenge = '${busy.challenge}'`,
  );
  const fast = await poll(request, busy);
  expect(fast.status()).toBe(429);
  const wait = (await fast.json()) as { retry_after: number };
  expect(Number(fast.headers()['retry-after'])).toBe(wait.retry_after);
  expect(wait.retry_after).toBeGreaterThanOrEqual(1);
  // Once the second has passed, the same grant issues its token: a sibling recorder for later.
  d1(`update recorder_grants set last_poll_at = 0 where challenge = '${busy.challenge}'`);
  const issued = await poll(request, busy);
  expect(issued.status()).toBe(200);
  const sibling = (await issued.json()) as { token: string; token_id: string };
  expect(sibling.token).toMatch(/^mtxt_/);

  // Expired: past its 10 minutes, the page and the poll both say so.
  const third = pkce();
  await page.goto(connectUrl(third.challenge, 'Lones iMac'));
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
  d1(`update recorder_grants set expires_at = 0 where challenge = '${third.challenge}'`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'This request has expired' })).toBeVisible();
  await expect(page.getByText(/Open the recorder and connect again\.$/)).toBeVisible();
  const expired = await poll(request, third);
  expect(expired.status()).toBe(410);
  expect((await expired.json()).error.code).toBe('expired');

  // A bad link explains itself too.
  await page.goto(connectUrl('short', 'Lones iMac'));
  await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();
  await page.goto(connectUrl(third.challenge, `${LONG_NAME}x`));
  await expect(page.getByRole('heading', { name: 'This link does not work' })).toBeVisible();

  // The recorder disconnects itself only: an unknown id and a sibling recorder's id are 404.
  const notMine = await request.delete('/api/v1/recorder/tokens/no-such-token', {
    headers: bearer(token),
  });
  expect(notMine.status()).toBe(404);
  const notSibling = await request.delete(`/api/v1/recorder/tokens/${sibling.token_id}`, {
    headers: bearer(token),
  });
  expect(notSibling.status()).toBe(404);
  await expect
    .poll(() => d1(`select revoked_at from recorder_tokens where id = '${sibling.token_id}'`))
    .toEqual([{ revoked_at: null }]);
  const self = await request.delete(`/api/v1/recorder/tokens/${token_id}`, {
    headers: bearer(token),
  });
  expect(self.status()).toBe(204);
  const after = await request.delete(`/api/v1/recorder/tokens/${token_id}`, {
    headers: bearer(token),
  });
  expect(after.status()).toBe(401);
});

test.describe('25 recorders and a 64-character device name (rule 13)', () => {
  test.beforeAll(async ({ baseURL }) => {
    expect([...LONG_NAME]).toHaveLength(64);
    const { request: create } = await import('@playwright/test');
    const ctx = await create.newContext({ baseURL });
    await signIn(ctx, RASMUS);
    await ctx.dispose();
    const id = d1<{ id: string }>(`select id from users where email = '${RASMUS.email}'`)[0]!.id;
    const now = Date.now();
    const rows = Array.from({ length: 25 }, (_, i) => {
      const name = i === 0 ? LONG_NAME : `Rasmus' laptop ${String(i + 1).padStart(2, '0')}`;
      const hash = createHash('sha256').update(`fixture-${i}-${now}`).digest('hex');
      const used = i % 3 === 0 ? 'null' : String(now - i * 3_600_000);
      return `('fx-${now}-${i}', 'dev', '${id}', '${name.replace(/'/g, "''")}', '${hash}', ${now - i * 86_400_000}, ${used}, ${now + 90 * 86_400_000})`;
    });
    d1(
      `insert into recorder_tokens (id, install_id, user_id, device_name, token_hash, created_at, last_used_at, expires_at) values ${rows.join(', ')}`,
    );
  });

  for (const viewport of [DESKTOP, PHONE]) {
    test(`connect page and Recorders screenshots at ${viewport.width}`, async ({
      page,
      context,
    }) => {
      await signIn(context.request, RASMUS);
      await page.setViewportSize(viewport);
      await page.goto(connectUrl(pkce().challenge, LONG_NAME));
      await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_NAME);
      // Nothing scrolls sideways at either width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await settle(page);
      await page.screenshot({ path: shot(`connect-${viewport.width}`), fullPage: true });

      await page.goto('/meetings');
      const dialog = await openRecorders(page);
      await expect(dialog.getByRole('heading', { name: '25 recorders' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: /^Disconnect / })).toHaveCount(25);
      await expect(dialog.getByText(LONG_NAME)).toBeVisible();
      await expect(dialog.getByText(/not used yet/).first()).toBeVisible();
      await settle(page);
      await page.screenshot({ path: shot(`recorders-${viewport.width}`) });
    });
  }

  test('keyboard walk of the connect page: Approve then Cancel, focus visible (rule 11)', async ({
    page,
    context,
    request,
  }) => {
    await signIn(context.request, RASMUS);
    await page.setViewportSize(DESKTOP);
    const pair = pkce();
    await page.goto(connectUrl(pair.challenge, 'Keyboard laptop'));
    const approve = page.getByRole('button', { name: 'Approve' });
    await tabTo(page, approve);
    await expectFocusRing(approve);
    await page.keyboard.press('Tab');
    await expectFocusRing(page.getByRole('button', { name: 'Cancel' }));
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Approved' })).toBeVisible();
    expect((await poll(request, pair)).status()).toBe(200);
  });

  test('keyboard walk of Recorders: focus in the dialog, Disconnect moves it on, Escape returns it (rule 11)', async ({
    page,
    context,
  }) => {
    await signIn(context.request, RASMUS);
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    const opener = page.getByRole('button', { name: 'Recorders', exact: true });
    await tabTo(page, opener);
    await expectFocusRing(opener);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Recorders' });
    await expect(dialog.getByRole('heading', { name: 'Recorders' })).toBeFocused();
    const disconnects = dialog.getByRole('button', { name: /^Disconnect / });
    await expect(disconnects).toHaveCount(26);
    // The newest first: the keyboard laptop from the last test.
    await page.keyboard.press('Tab');
    await expectFocusRing(dialog.getByRole('button', { name: 'Disconnect Keyboard laptop' }));
    await page.keyboard.press('Enter');
    await expect(disconnects).toHaveCount(25);
    await expect(dialog.getByRole('button', { name: `Disconnect ${LONG_NAME}` })).toBeFocused();
    // Shift+Tab from the first control wraps inside the dialog.
    await dialog
      .getByRole('button', { name: /^Disconnect / })
      .first()
      .focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('Disconnect rolls back with a message when the server does not answer (rule 2)', async ({
    page,
    context,
  }) => {
    await signIn(context.request, RASMUS);
    await page.setViewportSize(DESKTOP);
    await page.goto('/meetings');
    const dialog = await openRecorders(page);
    await expect(dialog.getByRole('heading', { name: '25 recorders' })).toBeVisible();
    await page.route('**/*', (route) =>
      route.request().method() === 'POST' && route.request().headers()['next-action']
        ? route.abort()
        : route.continue(),
    );
    await dialog.getByRole('button', { name: `Disconnect ${LONG_NAME}` }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      `${LONG_NAME} was not disconnected. Try again.`,
    );
    await expect(dialog.getByRole('heading', { name: '25 recorders' })).toBeVisible();
    await expect(dialog.getByTestId('recorders-list').getByText(LONG_NAME)).toBeVisible();
    await expect
      .poll(() =>
        d1(
          `select count(*) as n from recorder_tokens where device_name = '${LONG_NAME}' and revoked_at is null`,
        ),
      )
      .toEqual([{ n: 1 }]);
    await page.unroute('**/*');
  });
});

test('Recorders shows its three states: none, failed with Try again, and a list; an admin sees only their own', async ({
  page,
  context,
}) => {
  await signIn(context.request, USERS.dev);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  await page.route('**/*', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort()
      : route.continue(),
  );
  const dialog = await openRecorders(page);
  await expect(
    dialog.getByText('Could not load your recorders. Check the connection and try again.'),
  ).toBeVisible();
  await page.unroute('**/*');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  // The admin has no recorders of their own and sees no one else's.
  await expect(dialog.getByText('No recorders connected')).toBeVisible();
  await expect(dialog.getByText(RASMUS.name)).toHaveCount(0);

  // The audit log names the recorder actions, for admins.
  await page.keyboard.press('Escape');
  await page.goto('/settings/audit?action=recorder_connected');
  const table = page.getByTestId('audit-table');
  await expect(table.getByText('Recorder connected').first()).toBeVisible();
  await expect(table.getByText('Device: Lones MacBook Pro')).toBeVisible();
});
