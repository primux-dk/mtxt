import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
  // The app's own `@/` imports, for tests of server actions with their session mocked.
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
});
