import { defineConfig } from 'drizzle-kit';

// Migrations are generated here and applied by wrangler (`wrangler d1 migrations
// apply`), which reads this folder through `migrations_dir` in apps/web/wrangler.jsonc.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
});
