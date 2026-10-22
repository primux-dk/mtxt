// Lint config for packages/*. apps/web has its own, on top of Next's rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'packages/contract/src/types.ts',
      'packages/adapters/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
