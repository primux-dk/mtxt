import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8788);

/*
  The e2e test runs against `wrangler dev` on the OpenNext build: the same
  Worker that deploys, with local D1, R2, Queues and the Durable Object.
  E2E_PREBUILT=1 skips the build when CI has just made it.
*/
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
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
      process.env.E2E_PREBUILT ? null : 'pnpm build:cf',
      'pnpm db:migrate',
      'pnpm db:seed',
      `wrangler dev --port ${port} --inspector-port ${port + 1000}`,
    ]
      .filter(Boolean)
      .join(' && '),
    url: `http://localhost:${port}/meetings`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
