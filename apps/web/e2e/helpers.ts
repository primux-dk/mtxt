import type { Page } from '@playwright/test';

export const ADMIN = { email: 'mette.lund@example.com', name: 'Mette Lund', admin: true };
export const MEMBER = { email: 'anne.holm@example.com', name: 'Anne Holm', admin: false };

/**
 * Signs in through the e2e build's test sign-in (lib/auth/test-sign-in.ts):
 * the same user row and admin list a real sign-in writes, and a session
 * cookie in the page's context.
 */
/** Leave `admin` out to let the sign-in decide, as a real one does. */
export async function signIn(
  page: Page,
  user: { email: string; name: string; admin?: boolean } = ADMIN,
) {
  const response = await page.request.post('/api/test/sign-in', { data: user });
  if (!response.ok())
    throw new Error(`Test sign-in failed: ${response.status()} ${await response.text()}`);
}
