import { describe, expect, it, vi } from 'vitest';
import type { User } from '@mtxt/adapters';
import { ACCOUNT_CONFLICT_URL, makeCallbacks } from '../lib/auth/callbacks';
import {
  isTenantGuid,
  safeReturnTo,
  sessionToken,
  signInEmail,
  stripSignInParams,
} from '../lib/auth/identity';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://meetings.example.com';

describe('Entra tenant pinning', () => {
  it('accepts a GUID and nothing else', () => {
    expect(isTenantGuid(TENANT)).toBe(true);
    for (const value of ['common', 'organizations', 'consumers', 'contoso.onmicrosoft.com', '']) {
      expect(isTenantGuid(value), value).toBe(false);
    }
  });

  it('takes the address only from a token of the configured tenant', () => {
    const claims = { tid: TENANT, preferred_username: 'Mette@Contoso.com', email: 'other@x.com' };
    expect(signInEmail('entra', TENANT, claims)).toBe('mette@contoso.com');
    expect(
      signInEmail('entra', TENANT, { ...claims, tid: '00000000-0000-4000-8000-000000000009' }),
    ).toBeNull();
    expect(signInEmail('entra', TENANT, { ...claims, tid: undefined })).toBeNull();
    expect(signInEmail('entra', 'common', claims)).toBeNull();
  });

  it('prefers the UPN and falls back to the email claim only without one', () => {
    expect(
      signInEmail('entra', TENANT, {
        tid: TENANT,
        preferred_username: 'mette',
        email: 'mette@contoso.com',
      }),
    ).toBe('mette@contoso.com');
  });
});

describe('Google sign-in', () => {
  const claims = { hd: 'example.com', email: 'anne@example.com', email_verified: true };
  it('needs the Workspace domain and a verified address', () => {
    expect(signInEmail('google', 'example.com', claims)).toBe('anne@example.com');
    expect(signInEmail('google', 'example.com', { ...claims, hd: undefined })).toBeNull();
    expect(signInEmail('google', 'example.com', { ...claims, email_verified: false })).toBeNull();
    expect(signInEmail('google', 'example.com', { ...claims, hd: 'evil.example' })).toBeNull();
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/\t/evil.example.com', '/meetings'],
    ['//evil.example.com', '/meetings'],
    ['https://evil.example.com', '/meetings'],
    ['/\\evil.example.com', '/meetings'],
    ['/meetings\n', '/meetings'],
    ['meetings', '/meetings'],
    ['/meetings?x=1', '/meetings?x=1'],
    ['/design/', '/design/'],
  ])('%j goes to %s', (value, expected) => {
    expect(safeReturnTo(value, ORIGIN)).toBe(expected);
  });
});

describe('stripSignInParams', () => {
  it('keeps only callbackUrl and the CSRF token on a sign-in POST', async () => {
    const request = new Request(
      `${ORIGIN}/api/auth/signin/google?client_id=attacker&callbackUrl=/x`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'csrfToken=t&callbackUrl=%2Fmeetings&client_id=attacker&redirect_uri=https%3A%2F%2Fevil&scope=x&hd=evil&prompt=none&login_hint=a&nonce=n&state=s',
      },
    );
    const stripped = await stripSignInParams(request);
    expect(new URL(stripped.url).search).toBe('?callbackUrl=%2Fx');
    expect(Object.fromEntries(new URLSearchParams(await stripped.text()))).toEqual({
      csrfToken: 't',
      callbackUrl: '/meetings',
    });
  });

  it('leaves the callback route alone: it needs code and state', async () => {
    const request = new Request(`${ORIGIN}/api/auth/callback/google?code=c&state=s`);
    expect(await stripSignInParams(request)).toBe(request);
  });
});

describe('the session token', () => {
  it('holds only sub, name, email, iat, exp and signedInAt', () => {
    const token = sessionToken(
      {
        sub: 'u1',
        name: 'Mette',
        email: 'm@x.com',
        signedInAt: 1000,
        iat: 1,
        exp: 2,
        picture: 'data:...',
        uid: 'x',
      },
      null,
      60,
      2000,
    );
    expect(Object.keys(token!).sort()).toEqual([
      'email',
      'exp',
      'iat',
      'name',
      'signedInAt',
      'sub',
    ]);
  });

  it('ends 8 hours after sign-in', () => {
    const at = Date.now();
    const token = sessionToken({}, { id: 'u1', name: 'M', email: 'm@x.com' }, 8 * 3600, at)!;
    expect(sessionToken({ ...token }, null, 8 * 3600, at + 8 * 3600 * 1000 + 1)).toBeNull();
  });
});

describe('the Auth.js callbacks', () => {
  const user = {
    id: 'u1',
    name: 'Mette Lund',
    email: 'mette@contoso.com',
    oidcSubject: 's1',
  } as User;
  const profile = {
    tid: TENANT,
    preferred_username: 'mette@contoso.com',
    name: 'Mette Lund',
    picture: 'p',
    groups: ['g'],
  };
  const setup = (conflict: boolean) => {
    const record = vi.fn(async () => user);
    const hasConflict = vi.fn(async () => conflict);
    const callbacks = makeCallbacks({
      settings: { identityProvider: 'entra', oidcTenantId: TENANT },
      maxAge: 8 * 3600,
      hasConflict,
      record,
    });
    return { callbacks, record, hasConflict };
  };

  it('sends a second subject with a taken address to the conflict page, writing nothing', async () => {
    const { callbacks, record, hasConflict } = setup(true);
    expect(await callbacks.signIn({ account: { providerAccountId: 'other' }, profile })).toBe(
      ACCOUNT_CONFLICT_URL,
    );
    expect(hasConflict).toHaveBeenCalledWith({
      subject: 'other',
      email: 'mette@contoso.com',
      name: 'Mette Lund',
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a token from another tenant before looking anything up', async () => {
    const { callbacks, hasConflict } = setup(false);
    const foreign = { ...profile, tid: '00000000-0000-4000-8000-000000000009' };
    expect(await callbacks.signIn({ account: { providerAccountId: 's1' }, profile: foreign })).toBe(
      false,
    );
    expect(hasConflict).not.toHaveBeenCalled();
  });

  it('writes the user on sign-in and returns only the allowlisted keys', async () => {
    const { callbacks, record } = setup(false);
    expect(await callbacks.signIn({ account: { providerAccountId: 's1' }, profile })).toBe(true);
    const token = await callbacks.jwt({
      token: { name: 'Mette Lund', email: 'mette@contoso.com', picture: 'p', sub: 's1' },
      account: { providerAccountId: 's1' },
      profile,
    });
    expect(record).toHaveBeenCalledOnce();
    expect(token).toMatchObject({ sub: 'u1', name: 'Mette Lund', email: 'mette@contoso.com' });
    expect(Object.keys(token!).sort()).toEqual(['email', 'name', 'signedInAt', 'sub']);
  });
});
