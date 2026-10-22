import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8788);

/*
  The e2e test runs against `wrangler dev` on the OpenNext build: the same
  Worker that deploys, with local D1, R2, Queues and the Durable Object.
  It is the e2e build (`build:e2e`), which adds the test sign-in route, with
  its own local state under .wrangler/e2e and placeholder secrets from
  e2e/e2e.vars, so a run starts from a fresh install every time.
  E2E_PREBUILT=1 skips the build when CI has just made it.
*/
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // One worker: the files share one local install and its database.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    colorScheme: 'light',
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: [
      process.env.E2E_PREBUILT ? null : 'pnpm build:e2e',
      'rm -rf .wrangler/e2e',
      'pnpm db:migrate --persist-to .wrangler/e2e',
      'pnpm db:seed --persist-to .wrangler/e2e',
      `wrangler dev --port ${port} --inspector-port ${port + 1000} --env-file e2e/e2e.vars --persist-to .wrangler/e2e`,
    ]
      .filter(Boolean)
      .join(' && '),
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
