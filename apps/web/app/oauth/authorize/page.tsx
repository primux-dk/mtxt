import { TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { countMcpConnections, MAX_MCP_CONNECTIONS } from '@mtxt/adapters';
import { ConsentForm } from '@/components/oauth/consent-form';
import { Avatar } from '@/components/ui/avatar';
import { requireUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';
import { oauthContext, pageOrigin } from '@/lib/mcp/http';
import { checkAuthorize, redirectWith } from '@/lib/mcp/oauth';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata() {
  const t = await getTranslations('oauth');
  return { title: t('pageTitle') };
}

/** The address with every query parameter as it came, repeats included, for the login's return. */
function queryOf(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, value);
  }
  return query;
}

/**
 * /oauth/authorize (docs/spec.md "MCP"): where an MCP client sends the user
 * to connect. Signed out, the middleware sends the reader to the company
 * login and back here. A request with an unknown client or a redirect URI
 * the client did not register is shown here and never sent anywhere; any
 * other bad request goes back to the client with its error. Otherwise the
 * page asks once, with the access to give, Approve as the one primary and
 * Cancel.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const query = queryOf(await searchParams);
  const context = await oauthContext();
  if (!context) notFound();
  const [user, origin, t] = await Promise.all([
    requireUser(`/oauth/authorize?${query}`),
    pageOrigin(),
    getTranslations('oauth'),
  ]);
  const check = await checkAuthorize(context.settingsKey, query, origin);
  if (!check.ok && check.redirect) {
    redirect(
      redirectWith(
        check.redirectUri,
        { error: check.error, error_description: check.description, state: check.state },
        origin,
      ),
    );
  }
  const product = context.settings.productName;

  if (!check.ok) {
    return (
      <Frame product={product}>
        <section role="alert" aria-labelledby="oauth-invalid">
          <TriangleAlert
            aria-hidden="true"
            strokeWidth={1.5}
            className="mt-5 size-8 text-destructive"
          />
          <h1
            id="oauth-invalid"
            className="mt-4 text-[28px] leading-[1.2] tracking-[-0.045em] max-shell:text-2xl"
          >
            {t('invalid.title')}
          </h1>
          <p className="mt-3 mb-8 text-sm text-muted-foreground">{t(`invalid.${check.reason}`)}</p>
          <Link
            href="/meetings"
            className="text-sm font-[550] underline underline-offset-4 hover:text-accent-strong"
          >
            {t('toLibrary')}
          </Link>
        </section>
      </Frame>
    );
  }

  const { request } = check;
  const { db, installId } = await getAdapters();
  const full = (await countMcpConnections(db, installId, user.id)) >= MAX_MCP_CONNECTIONS;
  const returnsTo = (() => {
    const url = new URL(request.redirectUri);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.host
      : url.protocol.slice(0, -1);
  })();

  return (
    <Frame product={product}>
      <h1 className="mt-3 text-[28px] leading-[1.2] tracking-[-0.045em] [overflow-wrap:anywhere] max-shell:text-2xl">
        {t('title', { client: request.client.name, product })}
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
      <p className="mt-6 text-sm" data-testid="oauth-returns-to">
        {t.rich('returnsTo', {
          host: () => (
            <code className="font-mono text-[13px] [overflow-wrap:anywhere]">{returnsTo}</code>
          ),
        })}
      </p>
      <p className="mt-3 flex gap-2 text-sm font-[550]">
        <TriangleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-destructive"
          strokeWidth={1.5}
        />
        <span>{t('warning')}</span>
      </p>
      <p className="mt-3 mb-6 text-sm text-muted-foreground">{t('body')}</p>
      <ConsentForm
        query={query.toString()}
        scope={request.scope}
        full={full}
        max={MAX_MCP_CONNECTIONS}
      />
    </Frame>
  );
}

function Frame({ product, children }: { product: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-5 py-16 max-shell:justify-start max-shell:py-10">
      <div className="w-full max-w-[480px] rounded-panel border border-border bg-card p-10 max-shell:p-6">
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{product}</p>
        {children}
      </div>
    </main>
  );
}
