import { ArrowLeft, Inbox, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cn } from 'cn';
import type { WebhookDelivery, WebhookEndpoint } from '@mtxt/adapters';
import { EmptyState } from '@/components/library/empty-state';
import { RetryButton } from '@/components/library/retry-button';
import { LocalTime } from '@/components/local-time';
import { RefreshWhile } from '@/components/meeting/refresh-while';
import { PageTitle } from '@/components/page-title';
import { RetryDelivery, SendTest } from '@/components/settings/delivery-actions';
import { requireAdmin } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';
import { isTestMode } from '@/lib/test-mode';
import { answerKey, eventKey, statusKey } from '@/lib/webhooks/labels';
import { MAX_ATTEMPTS } from '@/lib/webhooks/rules';
import { findEndpoint, listDeliveries } from '@/lib/webhooks/store';

type Params = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
  One endpoint's delivery log (docs/spec.md "Webhooks", Delivery log): the
  last 50 deliveries with their status, attempts and last answer, and Retry
  now. Part of the admin surface: the middleware answers anyone else with
  the 403 page, and requireAdmin stands behind it. Metadata only. The log
  has no filter, so it has two empty states, none yet and a failed load
  (rule 8). While a delivery is queued or sending, the page looks again
  every few seconds. In AUTH_TEST_MODE `?state=failed` forces the failure.
*/
export default async function DeliveryLogPage({ params, searchParams }: Params) {
  const { id } = await params;
  await requireAdmin(`/settings/webhooks/${id}`);
  if (!UUID.test(id)) notFound();
  const [t, tl, testMode, query] = await Promise.all([
    getTranslations('settings.webhooks'),
    getTranslations('settings.webhooks.logPage'),
    isTestMode(),
    searchParams,
  ]);
  const { db, installId } = await getAdapters();
  let endpoint: WebhookEndpoint | undefined;
  let rows: WebhookDelivery[] | null = null;
  try {
    if (testMode && query.state === 'failed') throw new Error('Forced by ?state=failed');
    endpoint = await findEndpoint(db, installId, id);
    if (endpoint) rows = await listDeliveries(db, installId, id);
  } catch (error) {
    console.error('Could not load the delivery log', (error as Error).name);
  }
  if (rows && !endpoint) notFound();
  const name = endpoint?.label || t('unnamed');
  const busy = rows?.some(
    (r) =>
      r.status === 'sending' ||
      (r.status === 'pending' && r.nextAttemptAt.getTime() - Date.now() < 90_000),
  );

  const cell = 'border-b border-line-subtle px-4 py-3 align-top';
  return (
    <>
      <Link
        href="/settings/webhooks"
        className="mb-6 inline-flex min-h-10 items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground max-shell:mb-5"
      >
        <ArrowLeft aria-hidden="true" className="size-5" strokeWidth={1.5} />
        {tl('back')}
      </Link>
      <div className="mb-6 grid gap-3">
        <PageTitle
          level={2}
          title={tl('title', { name })}
          subheading={tl('subheading')}
          action={endpoint && <SendTest endpointId={endpoint.id} />}
        />
        {endpoint && (
          <dl className="grid gap-1 text-sm">
            <dt className="text-xs text-muted-foreground">{tl('url')}</dt>
            <dd className="font-mono text-xs break-all" data-testid="webhook-log-url">
              {endpoint.url}
            </dd>
            <dt className="mt-2 text-xs text-muted-foreground">{t('dialog.events')}</dt>
            <dd className="text-xs">
              {endpoint.events.map((e) => t(`eventNames.${eventKey(e)}`)).join(' · ')}
              {' · '}
              {endpoint.enabled ? t('enabled') : t('disabled')}
            </dd>
          </dl>
        )}
      </div>

      {busy && <RefreshWhile seconds={3} />}
      {rows === null && (
        <EmptyState
          tone="warning"
          Icon={TriangleAlert}
          title={tl('failed.title')}
          body={tl('failed.body')}
        >
          <RetryButton label={tl('failed.retry')} />
        </EmptyState>
      )}
      {rows?.length === 0 && (
        // The page's one primary, Send test event, sits in the header; the empty state points to it.
        <EmptyState Icon={Inbox} title={tl('empty.title')} body={tl('empty.body')}>
          {null}
        </EmptyState>
      )}
      {rows && rows.length > 0 && (
        <>
          <p className="mb-3 text-xs text-muted-foreground" data-testid="webhook-log-count">
            {tl('count', { count: rows.length })}
          </p>
          <div
            role="region"
            aria-labelledby="delivery-caption"
            tabIndex={0}
            className="overflow-x-auto rounded-card border border-border bg-card"
            data-testid="webhook-log"
          >
            <table className="w-full min-w-[860px] border-collapse text-left text-sm">
              <caption id="delivery-caption" className="sr-only">
                {tl('table.caption')}
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  {(
                    [
                      'time',
                      'event',
                      'meeting',
                      'status',
                      'attempts',
                      'answer',
                      'next',
                      'action',
                    ] as const
                  ).map((c) => (
                    <th key={c} scope="col" className="border-b border-border px-4 py-3 font-[550]">
                      {tl(`table.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = statusKey(row.status, row.attempts);
                  const answer = answerKey(row.lastError, row.lastStatusCode);
                  const queued = row.payload as {
                    meeting?: { title?: string } | null;
                    title?: string | null;
                  };
                  const title = queued.meeting?.title ?? queued.title ?? null;
                  const retryable =
                    row.status === 'parked' || (row.status === 'pending' && row.attempts > 0);
                  return (
                    <tr
                      key={row.id}
                      className="last:[&>td]:border-b-0"
                      data-testid="webhook-log-row"
                    >
                      <td className={`${cell} whitespace-nowrap tabular-nums`}>
                        <LocalTime
                          date={row.createdAt}
                          options={{ dateStyle: 'medium', timeStyle: 'medium' }}
                        />
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>
                        {t(`eventNames.${eventKey(row.event)}`)}
                      </td>
                      <td className={`${cell} max-w-[240px] break-words`}>
                        {title ?? tl('noMeeting')}
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>
                        <span
                          className={cn(
                            'inline-flex items-center rounded-pill border px-2 py-px text-xs',
                            status === 'delivered'
                              ? 'border-accent-line bg-accent-tint text-accent-foreground'
                              : status === 'parked'
                                ? 'border-destructive text-destructive'
                                : 'border-border text-muted-foreground',
                          )}
                        >
                          {t(`status.${status}`)}
                        </span>
                      </td>
                      <td className={`${cell} whitespace-nowrap tabular-nums`}>
                        {tl('attempts', { count: row.attempts, max: MAX_ATTEMPTS })}
                      </td>
                      <td className={`${cell} min-w-28 text-muted-foreground`}>
                        {t(`answer.${answer}`, { code: row.lastStatusCode ?? 0 })}
                      </td>
                      <td
                        className={`${cell} whitespace-nowrap tabular-nums text-muted-foreground`}
                      >
                        {row.status === 'pending' ? (
                          <LocalTime
                            date={row.nextAttemptAt}
                            options={{ dateStyle: 'medium', timeStyle: 'short' }}
                          />
                        ) : (
                          tl('noNext')
                        )}
                      </td>
                      <td className={cell}>
                        {retryable && (
                          <RetryDelivery
                            // Keyed on the server's attempt count: once that attempt is made, the
                            // row starts again from the server's state, never from a local "Queued".
                            key={`${row.id}:${row.attempts}`}
                            deliveryId={row.id}
                            label={tl('retryLabel', {
                              event: t(`eventNames.${eventKey(row.event)}`),
                              meeting: title ?? tl('noMeeting'),
                            })}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
