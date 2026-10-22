import { TriangleAlert } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { signIn } from '@/lib/auth';
import { loginSetup, PROVIDER_BRANDS, PROVIDER_IDS } from '@/lib/auth/provider';
import { getSessionUser } from '@/lib/auth/session';
import { getEnv, getInstallSettings } from '@/lib/install';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** Only a path on this site, so the login page cannot be used to send someone elsewhere. */
const safeReturn = (value: string | undefined) =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : '/meetings';

const ERRORS: Record<string, 'accessDenied' | 'configuration'> = {
  AccessDenied: 'accessDenied',
  Configuration: 'configuration',
};

/** The provider mark is monochrome text, not a logo asset (docs/design/README.md). */
const MARKS = { entra: '⊞', google: 'G' } as const;

/**
 * Figure 01: the product name, the company under it, one primary button for
 * the configured provider, and "An installation for {company}" at the foot.
 * mtxt does not appear.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const returnTo = safeReturn(one(params.callbackUrl));
  if (await getSessionUser()) redirect(returnTo);

  const [settings, env, t, tLogin] = await Promise.all([
    getInstallSettings(),
    getEnv(),
    getTranslations('auth'),
    getTranslations('login'),
  ]);
  const setup = await loginSetup(settings, env);
  const error = one(params.error);

  async function start() {
    'use server';
    if (setup.kind !== 'ready') return;
    await signIn(PROVIDER_IDS[setup.provider], { redirectTo: returnTo });
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-5 py-16">
      <div className="w-full max-w-[400px] rounded-panel border border-border bg-card p-10 max-shell:p-6">
        <h1 className="text-[28px] leading-[1.2] tracking-[-0.045em] [overflow-wrap:anywhere]">
          {settings.productName}
        </h1>
        {settings.companyName && (
          <p className="mt-3 text-muted-foreground [overflow-wrap:anywhere]">
            {settings.companyName}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-6 flex gap-2 text-sm text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.5}
            />
            <span>{t(`error.${ERRORS[error] ?? 'default'}`)}</span>
          </p>
        )}

        <div className="mt-8">
          {setup.kind === 'ready' && (
            <form action={start}>
              <Button type="submit" variant="primary" className="min-h-11 w-full">
                <span aria-hidden="true" className="w-5 text-[17px] leading-none font-[650]">
                  {MARKS[setup.provider]}
                </span>
                {tLogin('signInWith', { provider: PROVIDER_BRANDS[setup.provider] })}
              </Button>
            </form>
          )}
          {setup.kind === 'missing' && (
            <div role="status" className="grid gap-3 text-sm">
              <h2 className="text-base">{t('notConfigured.title')}</h2>
              <p className="text-muted-foreground">{t('notConfigured.body')}</p>
              <ul className="grid gap-1 font-mono text-[13px]">
                {setup.names.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </div>
          )}
          {setup.kind === 'broken' && (
            <div role="status" className="grid gap-3 text-sm">
              <h2 className="text-base">{t('broken.title')}</h2>
              <p className="text-muted-foreground">{t('broken.body')}</p>
            </div>
          )}
        </div>
      </div>
      {settings.companyName && (
        <p className="absolute bottom-7 px-5 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {tLogin('footer', { company: settings.companyName })}
        </p>
      )}
    </main>
  );
}
