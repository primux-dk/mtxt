import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export { schema };
export type Db = DrizzleD1Database<typeof schema>;

/** A Drizzle instance on the install's database. */
export function createDb(env: { DB: D1Database }): Db {
  return drizzle(env.DB, { schema });
}
