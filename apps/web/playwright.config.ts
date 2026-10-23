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
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Chromium's fake microphone, for the browser recorder test.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
  webServer: {
    command: [
      process.env.E2E_PREBUILT ? null : 'pnpm build:e2e',
      'rm -rf .wrangler/e2e',
      'pnpm db:migrate --persist-to .wrangler/e2e',
      // The dev users and a 30-meeting demo library (packet 3), with packet 6's
      // 40 colleagues, search transcripts, old meetings and 10,000 audit rows.
      'pnpm db:seed --demo=30 --persist-to .wrangler/e2e',
      // The origin and the fakes follow the port, so two worktrees can run side by side.
      `wrangler dev --local --define MTXT_E2E_BUILD:'"1"' --var MTXT_LOCAL_DEV:1` +
        ` --var PUBLIC_URL:http://localhost:${port}` +
        ` --var ASSEMBLYAI_BASE_URL:http://localhost:${port}/api/test/fake-assemblyai` +
        ` --var ELEVENLABS_BASE_URL:http://localhost:${port}/api/test/fake-elevenlabs` +
        ` --var WORKERS_AI_FAKE_URL:http://localhost:${port}/api/test/fake-workers-ai` +
        ` --var RECAP_FAKE_URL:http://localhost:${port}/api/test/fake-recap` +
        ` --port ${port} --inspector-port ${port + 1000} --env-file e2e/e2e.vars --persist-to .wrangler/e2e` +
        // --test-scheduled: GET /__scheduled runs the Cron Trigger (the retention spec).
        ` --test-scheduled` +
        // Everything the Worker logs, for the spec that checks no secret reaches it.
        ` > .wrangler/e2e-worker.log 2>&1`,
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
