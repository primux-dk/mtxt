import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

export const ADMIN = { email: 'mette.lund@example.com', name: 'Mette Lund', admin: true };
export const MEMBER = { email: 'anne.holm@example.com', name: 'Anne Holm', admin: false };

/**
 * Signs in through the e2e build's test sign-in (lib/auth/test-sign-in.ts):
 * the same user row and admin list a real sign-in writes, and a session
 * cookie in the page's context.
 */
/** Leave `admin` out to let the sign-in decide, as a real one does. */
export async function signIn(
  page: Page | APIRequestContext,
  user: { email: string; name: string; admin?: boolean; subject?: string } = ADMIN,
) {
  const request = 'request' in page ? page.request : page;
  const response = await request.post('/api/test/sign-in', { data: user });
  if (!response.ok())
    throw new Error(`Test sign-in failed: ${response.status()} ${await response.text()}`);
}

/**
 * The users the demo seed owns meetings for (packages/adapters/src/db/dev-seed.ts).
 * Their seeded subjects are the test sign-in's `test|<email>`, so signing in
 * as one of them lands on the seeded row and its meetings.
 */
export const USERS = {
  dev: ADMIN,
  colleague: { email: 'jonas.skov@example.com', name: 'Jonas Skov', admin: false },
  newcomer: MEMBER,
} as const;

/** Signs a browser context (its pages and its `request`) in as a seeded user. */
export async function asUser(context: BrowserContext, who: keyof typeof USERS) {
  await signIn(context.request, USERS[who]);
}
export const shot = (name: string) => `e2e/__screenshots__/${name}.png`;
export const DESKTOP = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };
/** --ring for the default accent #566b45 in light mode. */
export const SAGE = 'rgb(86, 107, 69)';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A mono 16-bit PCM WAV with a quiet tone: a real audio file the browser can play. */
export function wav(seconds: number, rate = 8000): Buffer {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  }
  return buffer;
}

export async function expectFocusRing(locator: Locator) {
  await expect(locator).toBeFocused();
  const outline = await locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      style: s.outlineStyle,
      width: s.outlineWidth,
      color: s.outlineColor,
      offset: s.outlineOffset,
    };
  });
  expect(outline).toEqual({ style: 'solid', width: '2px', color: SAGE, offset: '2px' });
}

export async function tabTo(page: Page, locator: Locator, max = 30) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error('Did not reach the element with Tab');
}

export async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
}

/**
 * Session cookies for the seeded users, as request headers, for API calls
 * made as someone other than the page's user. Filled in place by
 * `signInHeaders` (call it from a `beforeAll`), so module-level constants
 * that point at these objects work.
 */
export const SESSION_HEADERS: Record<keyof typeof USERS, Record<string, string>> = {
  dev: {},
  colleague: {},
  newcomer: {},
};

export async function signInHeaders(baseURL: string) {
  for (const who of Object.keys(USERS) as (keyof typeof USERS)[]) {
    const context = await playwrightRequest.newContext({ baseURL });
    await signIn(context, USERS[who]);
    const { cookies } = await context.storageState();
    SESSION_HEADERS[who].cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await context.dispose();
  }
}

const BUSY = /SQLITE_BUSY|database is locked/;

/**
 * Runs wrangler against the e2e run's local state. It opens the same SQLite
 * files as the running Worker, so while a job writes (the retention batches)
 * it can meet SQLITE_BUSY: the statement did not run, and it is tried again,
 * up to 20 times 250 ms apart. Any other failure throws at once, with
 * wrangler's stderr on the error.
 */
export function wrangler(args: string[]): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('wrangler', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      if (attempt >= 20 || !BUSY.test(stderr + String(error))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/**
 * A read on the e2e run's local D1 (.wrangler/e2e, playwright.config.ts),
 * for checks the API rightly cannot make, such as rows of another install.
 */
export function d1<T = Record<string, unknown>>(sql: string): T[] {
  const out = wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    '.wrangler/e2e',
    '--json',
    '--command',
    sql,
  ]);
  return JSON.parse(out)[0].results as T[];
}
