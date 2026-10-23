import { headers } from 'next/headers';
import { LoginForm } from '@/components/settings/login-form';
import { requireAdmin } from '@/lib/auth/session';
import { PROVIDER_IDS } from '@/lib/auth/provider';
import { getInstallSettings } from '@/lib/install';

/** The Login tab: identity provider and admins. Admins only. */
export default async function LoginSettingsPage() {
  await requireAdmin('/settings/login');
  const [settings, h] = await Promise.all([getInstallSettings(), headers()]);
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const callback = (id: string) => `${proto}://${host}/api/auth/callback/${id}`;
  return (
    <LoginForm
      values={{
        identityProvider: settings.identityProvider,
        oidcTenantId: settings.oidcTenantId ?? '',
        oidcClientId: settings.oidcClientId ?? '',
        adminEmails: settings.adminEmails.join('\n'),
      }}
      // Whether a secret is stored, never the secret.
      hasClientSecret={Boolean(settings.oidcClientSecret)}
      redirectUris={{ entra: callback(PROVIDER_IDS.entra), google: callback(PROVIDER_IDS.google) }}
    />
  );
}
