import 'server-only';
import NextAuth from 'next-auth';
import { hasSignInConflict, recordSignIn } from '@mtxt/adapters';
import { getAdapters, getEnv, getInstallSettings } from '../install';
import { makeCallbacks } from './callbacks';
import { authProvider } from './provider';
import { SESSION_MAX_AGE } from './session-config';

declare module 'next-auth' {
  interface Session {
    user: { id: string; name: string; email: string };
  }
}

/*
  Auth.js, built per request from the install's settings row, so a change to
  Company login on the settings page applies to the next sign-in. JWT
  sessions, 8 hours, no session table. One provider: the one configured.
*/
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const [env, settings, { db, installId }] = await Promise.all([
    getEnv(),
    getInstallSettings(),
    getAdapters(),
  ]);
  const provider = await authProvider(settings, env);
  const callbacks = makeCallbacks({
    settings,
    maxAge: SESSION_MAX_AGE,
    hasConflict: (profile) => hasSignInConflict(db, installId, profile),
    record: (profile) => recordSignIn(db, installId, profile),
  });
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE, updateAge: SESSION_MAX_AGE },
    jwt: { maxAge: SESSION_MAX_AGE },
    pages: { signIn: '/login', error: '/login' },
    providers: provider ? [provider] : [],
    callbacks: {
      signIn: ({ account, profile }) =>
        callbacks.signIn({ account, profile: profile as Record<string, unknown> | undefined }),
      // Auth.js types the token loosely; the callback returns only the allowlisted fields.
      jwt: async ({ token, account, profile }) =>
        (await callbacks.jwt({
          token,
          account,
          profile: profile as Record<string, unknown> | undefined,
        })) as never,
      session({ session, token }) {
        session.user = {
          ...session.user,
          id: String(token.sub ?? ''),
          name: String(token.name ?? ''),
          email: String(token.email ?? ''),
        };
        return session;
      },
    },
  };
});
