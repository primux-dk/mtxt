/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Two windows, two pages. Tauri serves `dist/` in a build and this dev server
// on port 1420 in `pnpm tauri dev`. The font and tokens come from docs/design,
// one level above the app, so the dev server may read there.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
  },
  build: {
    target: 'safari16',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        live: resolve(import.meta.dirname, 'live.html'),
      },
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
