import { and, eq } from 'drizzle-orm';
import type { Db } from './index';
import { users, type User } from './schema';
import { claimFirstAdmin, readSettings } from './settings';

export interface SignInProfile {
  /** The IdP's stable subject. */
  subject: string;
  email: string;
  name: string;
}

/**
 * Records a sign-in: the first user of a fresh install becomes admin, the
 * user row is created or its name and email refreshed, and `is_admin` is set
 * from the settings row's admin list.
 */
export async function recordSignIn(db: Db, installId: string, profile: SignInProfile) {
  const email = profile.email.trim().toLowerCase();
  await claimFirstAdmin(db, installId, email);
  const { adminEmails } = await readSettings(db, installId);
  const isAdmin = adminEmails.includes(email);
  const [user] = await db
    .insert(users)
    .values({ installId, oidcSubject: profile.subject, email, name: profile.name, isAdmin })
    .onConflictDoUpdate({
      target: [users.installId, users.oidcSubject],
      set: { email, name: profile.name, isAdmin },
    })
    .returning();
  return user as User;
}

export async function findUser(db: Db, installId: string, id: string) {
  return db.query.users.findFirst({ where: and(eq(users.installId, installId), eq(users.id, id)) });
}
