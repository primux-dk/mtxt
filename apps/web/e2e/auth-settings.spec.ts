import { expect, test, type Page } from '@playwright/test';
import { ADMIN, MEMBER, signIn } from './helpers';

const shot = (name: string) => `e2e/__screenshots__/${name}.png`;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

// Rule 13: a 120-character product name and a company name with æ, ø and å.
const PRODUCT =
  'Fiskerihavnens Værksted · mødebibliotek for produktionen, kvaliteten, vedligehold og ledelse på Ærø, Langeland og Sydfyn';
const COMPANY = 'Fiskerihavnens Værksted på Ærø ApS';

// The tests share one fresh install and build on each other's state.
test.describe.configure({ mode: 'serial' });

const settingsForm = (page: Page) => page.getByRole('form', { name: 'Settings' });
const save = (page: Page) => page.getByRole('button', { name: 'Save settings' });

test('the fixtures are the lengths rule 13 asks for', () => {
  expect(PRODUCT).toHaveLength(120);
  expect(COMPANY).toMatch(/æ/);
  expect(COMPANY).toMatch(/ø/);
  expect(COMPANY).toMatch(/å/);
});

test('signed out: pages go to the login page, API routes answer 401 JSON', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fsettings$/);
  const api = await page.request.get('/api/anything');
  expect(api.status()).toBe(401);
  expect(await api.json()).toEqual({ error: 'unauthorized', message: 'Sign in first.' });
  expect((await page.request.get('/design/')).url()).toMatch(/\/login\?callbackUrl=%2Fdesign%2F$/);
});

test('the login page offers the configured provider, and only that', async ({ page }) => {
  // e2e.vars bootstraps Entra ID on the first request.
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(1);
  // A fresh install is called "Meetings"; mtxt appears nowhere.
  await expect(page.getByRole('heading', { level: 1, name: 'Meetings' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('mtxt');
});

test('the first user to sign in on a fresh install becomes admin', async ({ page }) => {
  // The test sign-in takes the real sign-in path; the list was empty until now.
  await signIn(page, { email: ADMIN.email, name: ADMIN.name });
  const response = await page.goto('/settings');
  expect(response?.status()).toBe(200);
  await expect(page.getByLabel('Admin email addresses')).toHaveValue(ADMIN.email);
});

test('a second subject with an admin address is refused, and nothing changes', async ({ page }) => {
  const response = await page.request.post('/api/test/sign-in', {
    data: { email: ADMIN.email, name: 'Impostor', subject: 'another-subject' },
  });
  expect(response.status()).toBe(409);
  // The real sign-in path lands on the login page with this message.
  await page.goto('/login?error=AccountConflict');
  await expect(
    page.getByRole('alert').filter({ hasText: 'belongs to another account' }),
  ).toHaveText(
    'This address belongs to another account in this install. Nothing was changed. Contact your admin.',
  );
  await signIn(page, { email: ADMIN.email, name: ADMIN.name });
  await page.goto('/settings');
  await expect(page.locator('#adminEmails')).toHaveValue(ADMIN.email);
});

test('callbackUrl only ever returns to this site', async ({ page }) => {
  await signIn(page, MEMBER);
  for (const [value, expected] of [
    ['/\t/evil.example.com', /\/meetings$/],
    ['//evil.example.com', /\/meetings$/],
    ['https://evil.example.com', /\/meetings$/],
    ['/meetings?x=1', /\/meetings\?x=1$/],
  ] as const) {
    await page.goto(`/login?callbackUrl=${encodeURIComponent(value)}`);
    await expect(page, value).toHaveURL(expected);
    expect(page.url(), value).toMatch(/^http:\/\/localhost:\d+\//);
  }
});

test('a non-admin gets the 403 "Admins only" page on /settings', async ({ page }) => {
  await signIn(page, MEMBER);
  const response = await page.goto('/settings');
  expect(response?.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1, name: 'Admins only' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to my meetings' }).click();
  await expect(page).toHaveURL(/\/meetings$/);
});

test('an admin saves the product and company name and sees them in the shell', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  await page.getByLabel('Name', { exact: true }).first().fill(PRODUCT);
  await settingsForm(page).locator('#companyName').fill(COMPANY);
  await page.getByLabel('Keyterms').fill('Primux\nlinje 2,2\nugeplan');
  await save(page).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  const sidebar = page.locator('aside').first();
  await expect(sidebar).toContainText(PRODUCT);
  await expect(sidebar).toContainText(COMPANY);
  await expect(sidebar).toContainText(ADMIN.name);
  await page.reload();
  await expect(page.locator('#productName')).toHaveValue(PRODUCT);
  await expect(page.getByLabel('Keyterms')).toHaveValue('Primux\nlinje 2,2\nugeplan');
});

test('a theme colour under 4.5:1 is refused with the ratio, and what was typed stays', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  await page.locator('#companyName').fill(`${COMPANY} (typed, not saved)`);
  await page.locator('#themeAccent').fill('#a3c47d');
  // The live check warns before saving, with the same maths.
  await expect(page.getByText(/is \d\.\d:1 in light mode, under 4\.5:1/)).toBeVisible();
  await save(page).click();

  const summary = page.getByRole('alert').filter({ hasText: 'before the settings can be saved' });
  await expect(summary).toBeFocused();
  const link = summary.getByRole('link', { name: 'Accent colour' });
  await expect(link).toBeVisible();
  await expect(page.locator('#themeAccent-error')).toHaveText(
    /^Refused: Accent text on the background is \d\.\d:1 in light mode, under 4\.5:1\./,
  );
  await expect(page.locator('#themeAccent')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#companyName')).toHaveValue(`${COMPANY} (typed, not saved)`);
  // The summary's link takes focus to the field.
  await link.click();
  await expect(page.locator('#themeAccent')).toBeFocused();

  await page.reload();
  await expect(page.locator('#themeAccent')).toHaveValue('#566b45');
  await expect(page.locator('#companyName')).toHaveValue(COMPANY);
});

test('several errors are listed at the top with links (rule 9)', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  await page.locator('#productName').fill('');
  await page.locator('#retentionAudioDays').fill('0');
  await page.locator('#adminEmails').fill('not-an-email');
  await save(page).click();
  const summary = page.getByRole('alert').filter({ hasText: '3 fields need a change' });
  await expect(summary.getByRole('link')).toHaveText([
    'Product name',
    'Audio, days',
    'Admin email addresses',
  ]);
  await expect(page.locator('#retentionAudioDays-error')).toHaveText(
    'Enter a whole number of days from 1 to 3650.',
  );
  await expect(page.locator('#retentionAudioDays')).toHaveValue('0');
});

test('an admin cookie from before an email change carries no admin rights', async ({
  page,
  browser,
  baseURL,
}) => {
  // A is an admin under its own subject, and opens settings.
  await signIn(page, {
    email: 'a.old@example.com',
    name: 'Admin A',
    admin: true,
    subject: 'subject-a',
  });
  expect((await page.goto('/settings'))?.status()).toBe(200);

  // A signs in again elsewhere; the IdP now gives an address that is not on the list.
  const elsewhere = await browser.newContext({ baseURL });
  await signIn(elsewhere.request, {
    email: 'a.new@example.com',
    name: 'Admin A',
    subject: 'subject-a',
  });
  await elsewhere.close();

  // The old cookie still says a.old@, but the user row decides: no save, then 403.
  await page.locator('#productName').fill('Saved with a stale cookie');
  await save(page).click();
  await expect(page.getByText("Settings are for this install's admins.")).toBeVisible();
  await expect(page.getByText('Settings saved.')).toHaveCount(0);
  expect((await page.goto('/settings'))?.status()).toBe(403);

  await signIn(page, ADMIN);
  await page.goto('/settings');
  await expect(page.locator('#productName')).toHaveValue(PRODUCT);
});

test('an imported term with a line break survives save and reload', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  await page.locator('input[type=file]').setInputFiles({
    name: 'terms.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('"alpha\nbeta",2\r\n'),
  });
  await expect(page.getByText('Added 1 term from terms.csv.')).toBeVisible();
  await save(page).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Keyterms')).toHaveValue(
    'Primux\nlinje 2,2\nugeplan\n"alpha\nbeta",2',
  );

  // `alpha,2,` has three fields: refused with its record, nothing imported.
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('gamma\nalpha,2,\n'),
  });
  await expect(page.getByText(/Could not import bad\.csv\. Record 2:/)).toBeVisible();
  await expect(page.getByLabel('Keyterms')).toHaveValue(
    'Primux\nlinje 2,2\nugeplan\n"alpha\nbeta",2',
  );
});

test('a template is added and deleted, with a named confirmation', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  const list = page.getByRole('group', { name: 'Templates' });
  await expect(page.getByText('No templates yet.')).toBeVisible();

  await page.getByLabel('Template name').fill('Produktionsmøde');
  await page.getByLabel('Content in Markdown').fill('# Overblik\n\n## Beslutninger\n- [ ] Opgave');
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(list.getByRole('button', { name: /Produktionsmøde/ })).toBeVisible();
  await expect(page.getByText('Added Produktionsmøde.')).toBeVisible();
  await expect(list.getByRole('button', { name: /Produktionsmøde/ })).toContainText('Default');

  // A second template with the same name, in other casing, is refused at the field.
  await list.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Template name').fill('PRODUKTIONSMØDE');
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(page.locator('#template-name-error')).toHaveText(
    'A template called PRODUKTIONSMØDE exists already. Choose another name.',
  );
  await expect(list.getByRole('button', { name: /PRODUKTIONSMØDE/ })).toHaveCount(0);
  await page.getByLabel('Template name').fill('Projektstatus');
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(page.getByText('Added Projektstatus.')).toBeVisible();

  await page.reload();
  await expect(list.getByRole('button')).toHaveText([
    /Produktionsmøde/,
    'Projektstatus',
    'New template',
  ]);

  // Delete: the dialog names the template, Escape cancels and focus goes back.
  await list.getByRole('button', { name: 'Projektstatus' }).click();
  const remove = page.getByRole('button', { name: 'Delete template' });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Delete template' });
  await expect(dialog).toContainText('Delete the template Projektstatus permanently.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();

  await remove.click();
  await dialog.getByRole('button', { name: 'Delete template' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Deleted Projektstatus.')).toBeVisible();
  await expect(list.getByRole('button', { name: 'Projektstatus' })).toHaveCount(0);
  // The opener is gone, so focus lands on the list.
  await expect(list.getByRole('button').first()).toBeFocused();
  await page.reload();
  await expect(list.getByRole('button')).toHaveText([/Produktionsmøde/, 'New template']);
});

test('a template add the server never gets is rolled back (rule 2)', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  const list = page.getByRole('group', { name: 'Templates' });
  await list.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Template name').fill('Interview');

  // Server actions post to the page's own URL; this one never arrives.
  await page.route('**/settings', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Could not add Interview' }),
  ).toBeVisible();
  await expect(list.getByRole('button', { name: 'Interview' })).toHaveCount(0);
  await expect(page.getByLabel('Template name')).toHaveValue('Interview');

  // The retry, with the network back, adds it once.
  await page.unroute('**/settings');
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(page.getByText('Added Interview.')).toBeVisible();
  await page.reload();
  await expect(list.getByRole('button', { name: 'Interview' })).toHaveCount(1);
});

test('the settings form works from the keyboard alone (rule 11)', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings');
  await page.locator('#productName').focus();
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el
        ? el.id || el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName
        : '';
    });
    seen.push(label);
    if (label === 'Save settings') break;
    await page.keyboard.press('Tab');
  }
  expect(seen.at(-1)).toBe('Save settings');
  for (const id of [
    'companyName',
    'themeAccent',
    'themePrimary',
    'identityProvider',
    'oidcClientSecret',
    'sttProvider',
    'liveTranscriptDefault',
    'source-desktop',
    'template-name',
    'retentionAudioDays',
    'mcpEnabled',
    'adminEmails',
  ]) {
    expect(seen, id).toContain(id);
  }
  // The preview row is inert: none of its samples take focus.
  expect(seen).not.toContain('New meeting');
  // A toggle switches with Space and says so.
  await page.locator('#mcpEnabled').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#mcpEnabled')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Space');
  await expect(page.locator('#mcpEnabled')).toHaveAttribute('aria-pressed', 'false');
});

test('the data-flow panel names the chosen provider and the retention typed', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/settings');
  const panel = page.getByRole('complementary', { name: 'Data flow' });
  await expect(panel).toContainText('No speech-to-text provider is chosen yet.');
  await page.locator('#sttProvider').selectOption('assemblyai');
  await expect(panel).toContainText('AssemblyAI (EU) receives audio and keyterms directly');
  await expect(page.locator('#sttApiKey')).toBeVisible();
  await page.locator('#sttProvider').selectOption('workers-ai-whisper');
  await page.locator('#aiGatewayId').fill('');
  await expect(panel).toContainText(
    'No AI Gateway ID is set, so audio and keyterms go to it directly. It returns text without speakers.',
  );
  await expect(panel).toContainText('so the requests go to Workers AI directly');
  // With a gateway id typed, Workers AI and the recap model go through it.
  await page.locator('#aiGatewayId').fill('mtxt-gateway');
  await expect(panel).toContainText('Audio and keyterms go to it through AI Gateway.');
  await expect(panel).toContainText('and the requests go through AI Gateway');
  await page.locator('#sttProvider').selectOption('local-parakeet');
  await expect(panel).toContainText('Local Parakeet is not available in this version');
  await expect(page.locator('#sttApiKey')).toHaveCount(0);
  await page.locator('#retentionAudioDays').fill('14');
  await expect(panel).toContainText('Audio is deleted after 14 days.');
  await expect(panel).toContainText('Processing is not guaranteed to stay in the EU.');
});

test('a sign-in request cannot replace the client id', async ({ page }) => {
  // Google, because its discovery document is public; the e2e Entra tenant is a placeholder.
  await signIn(page, ADMIN);
  await page.goto('/settings');
  await page.locator('#identityProvider').selectOption('google');
  await page.locator('#oidcTenantId').fill('example.com');
  await page.locator('#oidcClientId').fill('e2e-google-client.apps.example');
  await page.locator('#oidcClientSecret').fill('e2e-google-secret-not-a-credential');
  await save(page).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  const { csrfToken } = await (await page.request.get('/api/auth/csrf')).json();
  const response = await page.request.post('/api/auth/signin/google?client_id=attacker', {
    form: {
      csrfToken,
      callbackUrl: '/meetings',
      client_id: 'attacker',
      redirect_uri: 'https://evil.example.com',
      hd: 'evil.example.com',
    },
    maxRedirects: 0,
  });
  const location = new URL(response.headers()['location'] ?? '');
  expect(location.host).toBe('accounts.google.com');
  expect(location.searchParams.get('client_id')).toBe('e2e-google-client.apps.example');
  expect(location.searchParams.get('hd')).toBe('example.com');
  expect(location.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/);

  // Back to Entra for the tests after this one.
  await page.goto('/settings');
  await page.locator('#identityProvider').selectOption('entra');
  await page.locator('#oidcTenantId').fill('00000000-0000-4000-8000-000000000001');
  await page.locator('#oidcClientId').fill('00000000-0000-4000-8000-000000000002');
  await page.locator('#oidcClientSecret').fill('e2e-client-secret-not-a-credential');
  await save(page).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
});

test.describe('in Danish', () => {
  test.use({ locale: 'da-DK' });

  test('Accept-Language: da gets the Danish interface', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'da');
    await expect(page.getByRole('button', { name: 'Log ind med Microsoft' })).toBeVisible();
    await expect(page.getByText(`En installation hos ${COMPANY}`)).toBeVisible();
    await signIn(page, ADMIN);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Indstillinger' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gem indstillinger' })).toBeVisible();
  });
});

test('sign out ends the session', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.setViewportSize(DESKTOP);
  await page.goto('/meetings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/meetings');
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmeetings$/);
});

test.describe('screenshots on the real build', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    test(`login and settings at ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: PRODUCT })).toBeVisible();
      await expect(page.getByText(`An installation for ${COMPANY}`)).toBeVisible();
      // Once the install has its own name, mtxt appears nowhere on the page.
      await expect(page.locator('body')).not.toContainText('mtxt');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: shot(`login-${viewport.width}`) });

      await signIn(page, ADMIN);
      await page.goto('/settings');
      await page.locator('#sttProvider').selectOption('assemblyai');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: shot(`settings-${viewport.width}`), fullPage: true });
    });
  }
});
