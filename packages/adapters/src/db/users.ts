import { and, eq, ne } from 'drizzle-orm';
import type { Db } from './index';
import { users, type User } from './schema';
import { claimFirstAdmin, readSettings } from './settings';

export interface SignInProfile {
  /** The IdP's stable subject. */
  subject: string;
  email: string;
  name: string;
}

/** A sign-in whose address already belongs to a user with another subject. Nothing was written. */
export class AccountConflictError extends Error {
  constructor() {
    super('The address belongs to another user (another subject).');
    this.name = 'AccountConflictError';
  }
}

/**
 * True when `email` already belongs to a user row with a different subject.
 * Identity is the subject: a second subject never inherits a row, nor the
 * admin flag the address carries.
 */
export async function hasSignInConflict(db: Db, installId: string, profile: SignInProfile) {
  const email = profile.email.trim().toLowerCase();
  const other = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.installId, installId),
        eq(users.email, email),
        ne(users.oidcSubject, profile.subject),
      ),
    )
    .limit(1);
  return other.length > 0;
}

/**
 * Records a sign-in: refuses a conflicting address before writing anything,
 * makes the first user of a fresh install admin, creates the user row or
 * refreshes its name and email, and sets `is_admin` from the admin list.
 */
export async function recordSignIn(db: Db, installId: string, profile: SignInProfile) {
  if (await hasSignInConflict(db, installId, profile)) throw new AccountConflictError();
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
