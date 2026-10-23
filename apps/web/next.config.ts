import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { pageExtensions } from './next-page-extensions';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  pageExtensions: pageExtensions(process.env.MTXT_E2E_BUILD),
  // Inlined at build time: the test sign-in's guard reads it (lib/auth/test-sign-in.ts).
  env: { MTXT_E2E_BUILD: process.env.MTXT_E2E_BUILD === '1' ? '1' : '' },
  // forbidden(): /settings answers a non-admin with a 403 page.
  experimental: { authInterrupts: true },
  transpilePackages: ['@mtxt/adapters', '@mtxt/contract'],
  // /design/ keeps its slash so the guidelines' relative links resolve under it.
  skipTrailingSlashRedirect: true,
  // The dev badge would land in the e2e screenshots.
  devIndicators: false,
  webpack(config) {
    // `?raw` imports a file as a string and `?base64` as base64 text, at build time.
    // Used to serve docs/design under /design without a second copy of the files.
    const oneOf = config.module.rules.find((rule: { oneOf?: unknown[] }) => rule?.oneOf)?.oneOf;
    oneOf.unshift(
      { resourceQuery: /raw/, type: 'asset/source' },
      {
        resourceQuery: /base64/,
        type: 'javascript/auto',
        use: [{ loader: fileURLToPath(new URL('./scripts/base64-loader.cjs', import.meta.url)) }],
      },
    );
    return config;
  },
};

export default withNextIntl(nextConfig);

// Gives `next dev` the bindings from wrangler.jsonc, with local D1 and R2. Remote
// bindings (Workers AI) need a Cloudflare login, so they are off unless asked for.
initOpenNextCloudflareForDev({ remoteBindings: process.env.MTXT_REMOTE_BINDINGS === '1' });
