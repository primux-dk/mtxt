import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  // The app's own `@/` imports, for tests of server actions with their session mocked.
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
});
