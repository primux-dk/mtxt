import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
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

// Gives `next dev` the bindings from wrangler.jsonc, with local D1 and R2.
initOpenNextCloudflareForDev();
