import 'server-only';
import NextAuth from 'next-auth';
import { recordSignIn } from '@mtxt/adapters';
import { getAdapters, getEnv, getInstallSettings } from '../install';
import { allowedProfile, authProvider } from './provider';
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
  const [env, settings] = await Promise.all([getEnv(), getInstallSettings()]);
  const provider = await authProvider(settings, env);
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE, updateAge: SESSION_MAX_AGE },
    jwt: { maxAge: SESSION_MAX_AGE },
    pages: { signIn: '/login', error: '/login' },
    providers: provider ? [provider] : [],
    callbacks: {
      signIn: ({ profile, user }) => Boolean(user.email) && allowedProfile(settings, profile),
      async jwt({ token, account, user }) {
        // Only on sign-in: create the user row, or refresh its name and email.
        if (account && user.email) {
          const { db, installId } = await getAdapters();
          const row = await recordSignIn(db, installId, {
            subject: account.providerAccountId,
            email: user.email,
            name: user.name || user.email,
          });
          token.uid = row.id;
          token.sub = row.oidcSubject;
          token.name = row.name;
          token.email = row.email;
          token.signedInAt = Date.now();
        }
        // Auth.js re-issues the cookie on every read; the 8 hours count from sign-in.
        const signedInAt = Number(token.signedInAt ?? 0);
        if (Date.now() - signedInAt > SESSION_MAX_AGE * 1000) return null;
        return token;
      },
      session({ session, token }) {
        session.user = {
          ...session.user,
          id: String(token.uid ?? ''),
          name: String(token.name ?? ''),
          email: String(token.email ?? ''),
        };
        return session;
      },
    },
  };
});
