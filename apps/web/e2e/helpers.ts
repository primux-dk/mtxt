import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/**
 * The SQLite file behind one of Miniflare's local stores in the e2e run's
 * state (.wrangler/e2e, playwright.config.ts): D1's database, or the R2
 * bucket's object index. One store each in this install.
 */
function localStore(kind: 'd1/miniflare-D1DatabaseObject' | 'r2/miniflare-R2BucketObject') {
  const dir = join('.wrangler/e2e/v3', kind);
  const [file, ...more] = readdirSync(dir).filter((f) => /^[0-9a-f]{64}\.sqlite$/.test(f));
  if (!file || more.length) throw new Error(`Expected one SQLite file in ${dir}`);
  return join(dir, file);
}

/**
 * Opens a local store's SQLite file beside the running Worker. The Worker
 * writes it in WAL mode; a read or write that meets its lock waits for it
 * (busy timeout, 10 s) instead of failing with SQLITE_BUSY. Opening the file
 * costs milliseconds, where a `wrangler d1 execute` boots its own Miniflare
 * for about 1.6 s and blocks the test's event loop meanwhile.
 */
export function withLocalStore<T>(
  kind: Parameters<typeof localStore>[0],
  run: (db: DatabaseSync) => T,
): T {
  const db = new DatabaseSync(localStore(kind), { timeout: 10_000 });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/**
 * A statement on the e2e run's local D1, for checks the API rightly cannot
 * make, such as rows of another install. Foreign keys are on, as in D1.
 * Several statements run as one script and return no rows.
 */
export function d1<T = Record<string, unknown>>(sql: string): T[] {
  return withLocalStore('d1/miniflare-D1DatabaseObject', (db) => {
    db.exec('PRAGMA foreign_keys = ON');
    if (sql.trim().replace(/;$/, '').includes(';')) {
      db.exec(sql);
      return [];
    }
    return db.prepare(sql).all() as T[];
  });
}
