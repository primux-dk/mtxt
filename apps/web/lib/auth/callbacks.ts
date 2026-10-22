/*
  The Auth.js callbacks, with the database calls passed in so unit tests can
  run them. lib/auth/index.ts wires them to the install's adapters.
*/
import type { Settings, SignInProfile, User } from '@mtxt/adapters';
import { sessionToken, signInEmail } from './identity';

export const ACCOUNT_CONFLICT_URL = '/login?error=AccountConflict';

export interface CallbackDeps {
  settings: Pick<Settings, 'identityProvider' | 'oidcTenantId'>;
  maxAge: number;
  hasConflict: (profile: SignInProfile) => Promise<boolean>;
  record: (profile: SignInProfile) => Promise<User>;
}

type Profile = Record<string, unknown> | undefined;
type Account = { providerAccountId: string } | null | undefined;

const nameOf = (profile: Profile, email: string) =>
  typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : email;

export function makeCallbacks(deps: CallbackDeps) {
  const email = (profile: Profile) =>
    signInEmail(deps.settings.identityProvider, deps.settings.oidcTenantId, profile);

  return {
    /** Refuses a foreign tenant or domain, and an address that belongs to another subject. Writes nothing. */
    async signIn({ account, profile }: { account?: Account; profile?: Profile }) {
      const address = email(profile);
      if (!account || !address) return false;
      const conflict = await deps.hasConflict({
        subject: account.providerAccountId,
        email: address,
        name: nameOf(profile, address),
      });
      return conflict ? ACCOUNT_CONFLICT_URL : true;
    },

    /** On sign-in, writes the user row; every time, keeps only the allowlisted fields. */
    async jwt({
      token,
      account,
      profile,
    }: {
      token: Record<string, unknown>;
      account?: Account;
      profile?: Profile;
    }) {
      let user: { id: string; name: string; email: string } | null = null;
      if (account && profile) {
        const address = email(profile);
        if (!address) return null;
        user = await deps.record({
          subject: account.providerAccountId,
          email: address,
          name: nameOf(profile, address),
        });
      }
      return sessionToken(token, user, deps.maxAge);
    },
  };
}
