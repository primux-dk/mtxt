import { CircleCheck, CircleX, Clock, TriangleAlert, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { findGrant } from '@mtxt/adapters';
import { ConnectForm } from '@/components/connect/connect-form';
import { Avatar } from '@/components/ui/avatar';
import { requireUser } from '@/lib/auth/session';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { connectParams, connectState, type ConnectState } from '@/lib/recorders/connect';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata() {
  const [t, { productName }] = await Promise.all([
    getTranslations('connect'),
    getInstallSettings(),
  ]);
  return { title: t('pageTitle', { product: productName }) };
}

const ICONS: Record<Exclude<ConnectState, 'ask'>, { Icon: LucideIcon; warn?: boolean }> = {
  approved: { Icon: CircleCheck },
  connected: { Icon: CircleCheck },
  denied: { Icon: CircleX, warn: true },
  expired: { Icon: Clock, warn: true },
  invalid: { Icon: TriangleAlert, warn: true },
};

/**
 * Where a desktop recorder sends the user to connect (docs/spec.md "Recorder
 * connection"). Signed out, the middleware sends the reader to the login page
 * and back here. The page asks once, with Approve as the one primary; after
 * that it shows what the grant says, so a reload or Back never asks again.
 */
export default async function ConnectPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const challenge = one(raw.challenge);
  const name = one(raw.name);
  const returnTo = `/connect?${new URLSearchParams({ challenge: challenge ?? '', name: name ?? '' })}`;
  const [user, settings, t] = await Promise.all([
    requireUser(returnTo),
    getInstallSettings(),
    getTranslations('connect'),
  ]);
  const params = connectParams(challenge, name);
  let state: ConnectState = 'invalid';
  if (params) {
    const { db, installId } = await getAdapters();
    state = connectState(await findGrant(db, installId, params.challenge), user.id);
  }
  const device = params?.deviceName ?? '';
  const product = settings.productName;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-16 max-shell:justify-start max-shell:py-10">
      <div className="w-full max-w-[480px] rounded-panel border border-border bg-card p-10 max-shell:p-6">
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{product}</p>
        {state === 'ask' && params ? (
          <>
            <h1 className="mt-3 text-[28px] leading-[1.2] tracking-[-0.045em] [overflow-wrap:anywhere] max-shell:text-2xl">
              {t('title', { device, product })}
            </h1>
            <div className="mt-6 flex min-w-0 items-center gap-3 rounded-control border border-line-subtle bg-secondary px-4 py-3">
              <Avatar name={user.name} />
              <div className="min-w-0 text-sm">
                <div className="text-xs text-muted-foreground">{t('signedInAs')}</div>
                <div className="truncate font-[550]" title={user.name}>
                  {user.name}
                </div>
                <div className="truncate text-muted-foreground" title={user.email}>
                  {user.email}
                </div>
              </div>
            </div>
            <p className="mt-6 mb-8 text-sm text-muted-foreground">{t('body')}</p>
            <ConnectForm challenge={params.challenge} deviceName={params.deviceName} />
          </>
        ) : (
          <Outcome state={state as Exclude<ConnectState, 'ask'>} device={device} t={t} />
        )}
      </div>
    </main>
  );
}

function Outcome({
  state,
  device,
  t,
}: {
  state: Exclude<ConnectState, 'ask'>;
  device: string;
  t: Awaited<ReturnType<typeof getTranslations<'connect'>>>;
}) {
  const { Icon, warn } = ICONS[state];
  return (
    <section role={warn ? 'alert' : 'status'} aria-labelledby="connect-outcome">
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={`mt-5 size-8 ${warn ? 'text-destructive' : 'text-accent-strong'}`}
      />
      <h1
        id="connect-outcome"
        className="mt-4 text-[28px] leading-[1.2] tracking-[-0.045em] [overflow-wrap:anywhere] max-shell:text-2xl"
      >
        {t(`${state}.title`, { device })}
      </h1>
      <p className="mt-3 mb-8 text-sm text-muted-foreground">{t(`${state}.body`, { device })}</p>
      <Link
        href="/meetings"
        className="text-sm font-[550] underline underline-offset-4 hover:text-accent-strong"
      >
        {t('toLibrary')}
      </Link>
    </section>
  );
}
