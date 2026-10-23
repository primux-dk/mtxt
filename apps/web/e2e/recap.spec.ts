import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
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
  tabTo,
  wav,
} from './helpers';

/*
  Packet 5: the recap. The recap job drafts with the e2e build's fake model
  (lib/recap/fake-llm.ts) after the fake AssemblyAI's transcript; the owner
  edits in the Tiptap editor, which saves itself (rule 1), refuses a stale
  save (rule 4), keeps text through a lost network and a reload, mentions
  colleagues, inserts blocks from the `/` menu, restores versions and
  exports Markdown and Word. A reader gets the recap read-only. Meetings are
  made as the seeded colleague, so the dev user's library keeps its 30; the
  seeded figure 04 recap (demo-0000) is only looked at, never changed.
*/
const KEY = 'ZTJlLXNldHRpbmdzLWtleS1ub3QtYS1zZWNyZXQtMDE='; // e2e/e2e.vars SETTINGS_KEY
const colleague = SESSION_HEADERS.colleague;
const TEMPLATE = '# Produktionsmøde\n\n## Status\n\n## Beslutninger\n\n## Næste skridt\n';

const recapControl = (request: APIRequestContext, mode: 'completed' | 'error' | 'unauthorised') =>
  request.post('/api/test/fake-recap/control', { data: { mode } });

/** A meeting of the colleague with an 80-second recording, transcribed by the fake AssemblyAI. */
async function transcribed(request: APIRequestContext, title: string) {
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
      async () =>
        (await (await request.get(`/api/v1/recordings/${id}`, { headers: colleague })).json())
          .status,
      { timeout: 30_000 },
    )
    .toBe('transcribed');
  return meeting_id as string;
}

const versionsOf = (meetingId: string) =>
  d1<{ number: number; author_id: string | null; note: string | null }>(
    `select v.number, v.author_id, v.note from recap_versions v join recaps r on r.id = v.recap_id
     where r.meeting_id = '${meetingId}' order by v.number`,
  );
const recapRow = (meetingId: string) =>
  d1<{ status: string; failure_reason: string | null; body_md: string }>(
    `select status, failure_reason, body_md from recaps where meeting_id = '${meetingId}'`,
  )[0];

/** A transcribed meeting with its AI draft, v1. */
async function drafted(request: APIRequestContext, title: string) {
  const meetingId = await transcribed(request, title);
  await expect.poll(() => versionsOf(meetingId).length, { timeout: 30_000 }).toBe(1);
  return meetingId;
}

const editor = (page: Page) => page.locator('.recap-body[contenteditable="true"]');
const versionLine = (page: Page) => page.getByTestId('recap-version');
const status = (page: Page) =>
  page.getByRole('status').filter({ hasText: /Saving|Saved|Not saved|Changed elsewhere/ });

/** Puts the caret at the end of the document's first heading, on a new line. */
async function newLineAfterHeading(page: Page) {
  await editor(page).locator('h2').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
}

let meetingId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ baseURL }) => {
  await signInHeaders(baseURL!);
  const key = await seal('e2e-assemblyai-key', 'settings.stt_api_key', KEY);
  d1(`update settings set stt_provider = 'assemblyai', stt_api_key = '${key}', language = 'auto'`);
  d1(
    `insert or ignore into templates (id, install_id, name, name_key, body_md, is_default)
     values ('e2e-recap-template', 'dev', 'Produktionsmøde (e2e)', 'produktionsmøde (e2e)', '${TEMPLATE}', 0)`,
  );
  d1(`update templates set is_default = (id = 'e2e-recap-template')`);
});

test.afterAll(() => {
  d1(`update settings set stt_provider = NULL, stt_api_key = NULL`);
  d1(`update templates set is_default = 0 where id = 'e2e-recap-template'`);
});

test.beforeEach(async ({ context, request }) => {
  await asUser(context, 'colleague');
  await recapControl(request, 'completed');
  await request.post('/api/test/fake-assemblyai/control', {
    data: { mode: 'completed', delayMs: 500 },
  });
});

test('the recap job drafts version 1 from the template and the transcript, with the decisions', async ({
  page,
  request,
}) => {
  meetingId = await drafted(request, 'Referatmøde');
  expect(versionsOf(meetingId)).toEqual([{ number: 1, author_id: null, note: null }]);
  const body = recapRow(meetingId)!.body_md;
  // The template's headings, in order.
  expect(body.indexOf('# Produktionsmøde')).toBeLessThan(body.indexOf('## Status'));
  expect(body.indexOf('## Status')).toBeLessThan(body.indexOf('## Beslutninger'));
  expect(body).toContain('<!-- decisions -->');
  // The fake model's owner is a speaker of the meeting: a mention of that speaker.
  expect(body).toMatch(/\[@Speaker 1\]\(mtxt:speaker\/[a-f0-9-]+\)/);
  const decisions = d1<{ text: string; done: number }>(
    `select d.text, d.done from decisions d join recaps r on r.id = d.recap_id where r.meeting_id = '${meetingId}' order by d.position`,
  );
  expect(decisions).toHaveLength(2);
  expect(decisions[0]!.done).toBe(0);
  // What the model was asked: the template, then the transcript as "Speaker: text" with minute lines.
  const sent = await (await request.get('/api/test/fake-recap/control')).json();
  expect(sent.last.user).toContain('Template:\n\n# Produktionsmøde');
  expect(sent.last.user).toMatch(/Transcript:\n\n\[00:00\]\nSpeaker 1: /);
  expect(sent.last.max_tokens).toBe(4000);
  expect(sent.last.system).toContain('Do not invent');

  await page.goto(`/meetings/${meetingId}`);
  // The recap tab opens first when a recap exists.
  await expect(page.getByRole('tab', { name: 'Recap' })).toHaveAttribute('aria-selected', 'true');
  await expect(versionLine(page)).toHaveText(/^AI draft v1\s*· Saved$/);
  await expect(editor(page).getByRole('heading', { name: 'Beslutninger' })).toBeVisible();
  // The search index has the recap: a word only the recap holds finds the meeting.
  await page.goto(`/meetings?q=${encodeURIComponent('Produktionsmøde')}&view=mine`);
  await expect(page.getByRole('link', { name: 'Referatmøde' })).toBeVisible();
});

test('the owner edits: Saving, then Saved, and the text is there after a reload (rule 1)', async ({
  page,
}) => {
  await page.goto(`/meetings/${meetingId}`);
  await newLineAfterHeading(page);
  await page.keyboard.type('Første ændring fra ejeren.');
  await expect(status(page)).toContainText('Saving');
  await expect(status(page)).toContainText('Saved', { timeout: 10_000 });
  await expect(versionLine(page)).toHaveText(/^AI draft v1, edited by Jonas Skov v2\s*· Saved$/);
  await page.reload();
  await expect(editor(page)).toContainText('Første ændring fra ejeren.');
  expect(versionsOf(meetingId).map((v) => v.author_id)).toEqual([null, 'dev-colleague']);
});

test('offline: Not saved, never Saved; back online it saves; a reload restores unsaved text', async ({
  page,
  context,
}) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`/meetings/${meetingId}`);
  await expect(status(page)).toContainText('Saved');
  await context.setOffline(true);
  await newLineAfterHeading(page);
  await page.keyboard.type('Skrevet uden net.');
  await expect(status(page)).toContainText('Not saved');
  await expect(status(page)).toContainText('no network, kept in this browser');
  // The pause and more pass: still not Saved, since the server never got it.
  await page.waitForTimeout(2500);
  await expect(status(page)).toContainText('Not saved');
  await context.setOffline(false);
  await expect(status(page)).toContainText('Saved', { timeout: 15_000 });
  expect(recapRow(meetingId)!.body_md).toContain('Skrevet uden net.');

  // The server never answers: the text survives a reload from the browser's own copy.
  await page.route('**/api/v1/meetings/*/recap', (route) =>
    route.request().method() === 'PUT' ? route.abort('internetdisconnected') : route.continue(),
  );
  await newLineAfterHeading(page);
  await page.keyboard.type('Aldrig bekræftet.');
  await expect(status(page)).toContainText('Not saved', { timeout: 10_000 });
  await page.reload();
  await expect(editor(page)).toContainText('Aldrig bekræftet.');
  await expect(status(page)).toContainText('Not saved');
  await page.unroute('**/api/v1/meetings/*/recap');
  await expect(status(page)).toContainText('Saved', { timeout: 15_000 });
  expect(recapRow(meetingId)!.body_md).toContain('Aldrig bekræftet.');
});

test('two windows: the second gets "Changed elsewhere · Reload", never a silent overwrite (rule 4)', async ({
  context,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto(`/meetings/${meetingId}`);
  await second.goto(`/meetings/${meetingId}`);
  await newLineAfterHeading(first);
  await first.keyboard.type('Fra det første vindue.');
  await expect(status(first)).toContainText('Saved', { timeout: 10_000 });
  await newLineAfterHeading(second);
  await second.keyboard.type('Fra det andet vindue.');
  await expect(status(second)).toContainText(/Changed elsewhere by Jonas Skov/, {
    timeout: 10_000,
  });
  const reload = second.getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();
  const body = recapRow(meetingId)!.body_md;
  expect(body).toContain('Fra det første vindue.');
  expect(body).not.toContain('Fra det andet vindue.');
  // After Reload, the server's text, and the unsaved one offered, not applied.
  await reload.click();
  await expect(second.getByText(/was not saved, and the recap has changed since/)).toBeVisible();
  await expect(editor(second)).not.toContainText('Fra det andet vindue.');
  await second.getByRole('button', { name: 'Discard it' }).click();
  await first.close();
  await second.close();
});

test('the / menu inserts a callout and a table; @ mentions a colleague; a tick saves at once', async ({
  page,
}) => {
  await page.goto(`/meetings/${meetingId}`);
  const menu = page.getByRole('listbox', { name: 'Blocks' });
  await newLineAfterHeading(page);
  await page.keyboard.type('/table');
  await expect(menu.getByRole('option')).toHaveText(['Table of contents', 'Table']);
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('option', { name: 'Table', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(editor(page).locator('table')).toHaveCount(1);
  await page.keyboard.type('Opgave');
  await newLineAfterHeading(page);
  await page.keyboard.type('/note');
  await expect(menu.getByRole('option', { name: 'Note' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await page.keyboard.type('En vigtig note.');
  const note = editor(page)
    .locator('aside[data-kind="note"]')
    .filter({ hasText: 'En vigtig note.' });
  await expect(note).toHaveCount(1);

  // A mention: colleagues and the meeting's speakers.
  await note.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Spørg @ann');
  const people = page.getByRole('listbox', { name: 'Colleagues and speakers' });
  await expect(people.getByRole('option').first()).toContainText('Anne Holm');
  await page.keyboard.press('Enter');
  await expect(editor(page).locator('.mention', { hasText: '@Anne Holm' })).toBeVisible();
  await expect(status(page)).toContainText('Saved', { timeout: 10_000 });
  const body = recapRow(meetingId)!.body_md;
  expect(body).toMatch(
    /> \[!NOTE\]\n> En vigtig note\. Spørg \[@Anne Holm\]\(mtxt:user\/dev-newcomer\)/,
  );
  expect(body).toMatch(/\| Opgave \|/);

  // Ticking a decision is optimistic and saves without the pause; the row follows.
  const tick = page.getByRole('checkbox', { name: /^Mark as done: / }).first();
  await tick.check();
  await expect(tick).toBeChecked();
  await expect(status(page)).toContainText('Saved', { timeout: 5_000 });
  const [row] = d1<{ done: number }>(
    `select d.done from decisions d join recaps r on r.id = d.recap_id where r.meeting_id = '${meetingId}' and d.position = 0`,
  );
  expect(row!.done).toBe(1);
});

test('versions: the panel lists every version, previews one and restores it as a new version', async ({
  page,
}) => {
  await page.goto(`/meetings/${meetingId}`);
  const before = versionsOf(meetingId).length;
  const opener = page.getByRole('button', { name: 'Versions' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Versions' });
  await expect(dialog.getByRole('button', { name: /^v1, AI draft/ })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: new RegExp(`^v${before}, Jonas Skov`) }),
  ).toContainText('Current');
  await dialog.getByRole('button', { name: /^v1, AI draft/ }).click();
  await expect(dialog.getByRole('document', { name: 'Version 1' })).not.toContainText(
    'Første ændring',
  );
  await dialog.getByRole('button', { name: 'Restore v1' }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(versionLine(page)).toHaveText(
    new RegExp(`^AI draft v1, edited by Jonas Skov v${before + 1}\\s*· Saved$`),
  );
  await expect(editor(page)).not.toContainText('Første ændring');
  const versions = versionsOf(meetingId);
  expect(versions.at(-1)).toEqual({
    number: before + 1,
    author_id: 'dev-colleague',
    note: 'restored:1',
  });
  // The panel says where it came from.
  await opener.click();
  await expect(dialog.getByText('Restored from v1')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('export: Markdown is the stored body, Word holds the recap; one audit row each', async ({
  page,
}) => {
  await page.goto(`/meetings/${meetingId}`);
  const before = d1<{ n: number }>(
    `select count(*) as n from audit_events where meeting_id = '${meetingId}' and action = 'exported'`,
  )[0]!.n;
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export the recap' });
  const [md] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: /Markdown/ }).click(),
  ]);
  expect(md.suggestedFilename()).toBe('Referatmøde 2026-10-22.md');
  expect(readFileSync((await md.path())!, 'utf8')).toBe(recapRow(meetingId)!.body_md);
  const [docx] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: /Word/ }).click(),
  ]);
  expect(docx.suggestedFilename()).toBe('Referatmøde 2026-10-22.docx');
  const zip = await JSZip.loadAsync(readFileSync((await docx.path())!));
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('Referatmøde');
  expect(xml).toContain('w:val="Heading1"');
  expect(xml).toContain('Beslutninger');
  expect(xml).not.toContain('mtxt:');
  const rows = d1<{ details: string }>(
    `select details from audit_events where meeting_id = '${meetingId}' and action = 'exported' order by at`,
  );
  expect(rows.length - before).toBe(2);
  expect(rows.slice(-2).map((r) => JSON.parse(r.details).format)).toEqual(['md', 'docx']);
});

test('a reader gets the recap read-only, and may export it', async ({ browser }) => {
  d1(`update meetings set visibility = 'company' where id = '${meetingId}'`);
  const reader = await browser.newContext({ viewport: DESKTOP, locale: 'en-GB' });
  await asUser(reader, 'newcomer');
  const page = await reader.newPage();
  await page.goto(`/meetings/${meetingId}`);
  const body = page.locator('.recap-body');
  await expect(body).toHaveAttribute('contenteditable', 'false');
  await expect(body).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByRole('toolbar', { name: 'Recap formatting' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Regenerate draft' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /^Mark as done/ }).first()).toBeDisabled();
  // No save status for a reader; the version line is there.
  await expect(versionLine(page)).toHaveText(/^AI draft v1, edited by Jonas Skov v\d+$/);
  await expect(status(page)).toHaveCount(0);
  // The save refuses a reader whatever the page shows.
  const refused = await page.request.put(`/api/v1/meetings/${meetingId}/recap`, {
    data: { base_version_id: null, body_md: '# Nej' },
  });
  expect(refused.status()).toBe(403);
  const exported = await page.request.get(`/api/v1/meetings/${meetingId}/export?format=md`);
  expect(exported.status()).toBe(200);
  await reader.close();
  d1(`update meetings set visibility = 'private' where id = '${meetingId}'`);
});

test('a draft that fails says why with Try again; regenerate adds an AI version on top of the human ones', async ({
  page,
  request,
}) => {
  await recapControl(request, 'unauthorised');
  const failing = await transcribed(request, 'Referat der fejler');
  await expect.poll(() => recapRow(failing)?.status, { timeout: 30_000 }).toBe('failed');
  expect(recapRow(failing)!.failure_reason).toBe('unauthorised:401');
  await page.goto(`/meetings/${failing}`);
  await page.getByRole('tab', { name: 'Recap' }).click();
  await expect(page.getByRole('heading', { name: 'The recap could not be drafted' })).toBeVisible();
  await expect(page.getByText('The recap model refused the API key (HTTP 401).')).toBeVisible();
  await recapControl(request, 'completed');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(versionLine(page)).toHaveText(/^AI draft v1\s*· Saved$/, { timeout: 30_000 });

  // Regenerate on the edited meeting: the human versions stay, the AI's is the next one.
  const before = versionsOf(meetingId);
  await page.goto(`/meetings/${meetingId}`);
  await page.getByRole('button', { name: 'Regenerate draft' }).click();
  await expect
    .poll(() => versionsOf(meetingId).length, { timeout: 30_000 })
    .toBe(before.length + 1);
  expect(versionsOf(meetingId).at(-1)!.author_id).toBeNull();
  expect(versionsOf(meetingId).slice(0, before.length)).toEqual(before);
  await expect(versionLine(page)).toHaveText(
    new RegExp(`^AI draft v${before.length + 1}\\s*· Saved$`),
    {
      timeout: 15_000,
    },
  );
});

test('keyboard: the toolbar, the menus, the versions panel and the export dialog (rule 11)', async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/meetings/${meetingId}`);
  // The panel head, then the toolbar: Tab enters it once, the arrows move inside.
  const versions = page.getByRole('button', { name: 'Versions' });
  await tabTo(page, versions, 40);
  await expectFocusRing(versions);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Versions' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(versions).toBeFocused();
  const heading = page.getByRole('button', { name: 'Apply heading' });
  await tabTo(page, heading, 10);
  await expectFocusRing(heading);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Toggle bold' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: 'Add link' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(heading).toBeFocused();
  // Tab leaves the toolbar for the document.
  await page.keyboard.press('Tab');
  await expect(editor(page)).toBeFocused();
  // The / menu: arrows, Escape closes it without a block.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.getByRole('listbox', { name: 'Blocks' });
  await expect(menu).toBeVisible();
  await expect(editor(page)).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Backspace');
  // The link dialog from the toolbar: a title, focus inside, back to its button.
  const link = page.getByRole('button', { name: 'Add link' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Link' })).toBeVisible();
  await expect(page.getByLabel('Address')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(link).toBeFocused();
  // Export opens its dialog and returns focus.
  const exportButton = page.getByRole('button', { name: 'Export' });
  await exportButton.focus();
  await page.keyboard.press('Enter');
  const exportDialog = page.getByRole('dialog', { name: 'Export the recap' });
  await expect(exportDialog).toBeVisible();
  // Focus moves into the dialog and stays there; both formats are reached with Tab.
  await expect(exportDialog.locator(':focus')).toHaveCount(1);
  await tabTo(page, page.getByRole('link', { name: /Markdown/ }), 4);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /Word/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(exportButton).toBeFocused();
});

async function asDev(context: BrowserContext) {
  await context.clearCookies();
  await asUser(context, 'dev');
}

test('screenshots at 1280 and 390: the editor, the / menu, versions, export; the long recap', async ({
  page,
  context,
}) => {
  // Figure 04's recap, as its owner sees it. Only looked at: nothing is typed here.
  await asDev(context);
  for (const [name, size] of [
    ['desktop', DESKTOP],
    ['phone', PHONE],
  ] as const) {
    await page.setViewportSize(size);
    await page.goto('/meetings/demo-0000');
    await expect(versionLine(page)).toHaveText(/^AI draft v1, edited by Mette Lund v4\s*· Saved$/);
    await settle(page);
    await page.screenshot({ path: shot(`recap-editor-${name}`), fullPage: true });

    await page.getByRole('button', { name: 'Versions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Versions' });
    await expect(dialog.getByRole('document', { name: 'Version 4' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`recap-versions-${name}`) });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByRole('dialog', { name: 'Export the recap' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`recap-export-${name}`) });
    await page.keyboard.press('Escape');
  }
  expect(versionsOf('demo-0000')).toHaveLength(4);

  // The / menu on the colleague's meeting.
  await context.clearCookies();
  await asUser(context, 'colleague');
  for (const [name, size] of [
    ['desktop', DESKTOP],
    ['phone', PHONE],
  ] as const) {
    await page.setViewportSize(size);
    await page.goto(`/meetings/${meetingId}`);
    await newLineAfterHeading(page);
    await page.keyboard.type('/');
    await expect(page.getByRole('listbox', { name: 'Blocks' })).toBeVisible();
    await settle(page);
    await page.screenshot({ path: shot(`recap-slash-menu-${name}`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await expect(status(page)).toContainText('Saved', { timeout: 10_000 });
  }

  // Rule 13: 3,000 words, 40 decisions and a 120-character heading, at a phone's width too.
  await asDev(context);
  for (const [name, size] of [
    ['desktop', DESKTOP],
    ['phone', PHONE],
  ] as const) {
    await page.setViewportSize(size);
    await page.goto('/meetings/demo-0001');
    await page.getByRole('tab', { name: 'Recap' }).click();
    await expect(page.getByRole('checkbox', { name: /^Mark as done: Beslutning/ })).toHaveCount(40);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(size.width);
    // The 120-character heading inside the recap, then the 40 decisions.
    await editor(page).locator('h2').first().scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: shot(`recap-long-${name}`) });
    await editor(page).getByRole('heading', { name: 'Beslutninger' }).scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: shot(`recap-long-decisions-${name}`) });
  }
});
