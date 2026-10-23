// Lint config for packages/* and the recorder's TypeScript. apps/web has its own, on top of Next's rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'packages/contract/src/types.ts',
      'packages/adapters/migrations/**',
      'apps/recorder/src-tauri/**',
      'apps/recorder/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
