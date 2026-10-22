import { ScrollText, Search, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AUDIT_ACTIONS } from '@mtxt/adapters';
import { AuditTable } from '@/components/audit/audit-table';
import { EmptyState } from '@/components/library/empty-state';
import { FilterPills } from '@/components/library/filter-pills';
import { Pagination } from '@/components/library/pagination';
import { RetryButton } from '@/components/library/retry-button';
import { SortSelect } from '@/components/library/sort-select';
import { PageTitle } from '@/components/page-title';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth/session';
import { AUDIT_PAGE_SIZE, auditHref, isAuditFiltered, parseAuditParams } from '@/lib/audit/params';
import { listAuditEvents, type AuditPage } from '@/lib/audit/queries';
import { getAdapters } from '@/lib/install';
import { isTestMode } from '@/lib/test-mode';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/*
  The audit log, part of the settings page's admin surface (docs/spec.md).
  Admins only: the middleware answers anyone else with the 403 page, and
  requireAdmin stands behind it. The same list parts as the library (rule
  7): filter pills by action with counts, a select by user, a count, page
  links, all in the URL (rules 5, 6), and the three empty states (rule 8).
  In AUTH_TEST_MODE `?state=failed` forces the failure for the e2e test.
*/
export default async function AuditPageView({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin('/settings/audit');
  const raw = await searchParams;
  const params = parseAuditParams(raw);
  const [t, format, testMode] = await Promise.all([
    getTranslations('audit'),
    getFormatter(),
    isTestMode(),
  ]);

  let page: AuditPage | null = null;
  try {
    if (testMode && raw.state === 'failed') throw new Error('Forced by ?state=failed');
    const { db, installId } = await getAdapters();
    page = await listAuditEvents(db, installId, params);
  } catch (error) {
    console.error('Could not load the audit log', error);
  }
  const state = !page
    ? 'failed'
    : page.total > 0
      ? 'list'
      : isAuditFiltered(params)
        ? 'nomatch'
        : 'first';
  const from = page ? (page.page - 1) * AUDIT_PAGE_SIZE + 1 : 0;

  return (
    <>
      <div className="mb-6">
        <PageTitle title={t('title')} subheading={t('subheading')} />
      </div>

      {page && (
        <div className="flex flex-wrap items-end justify-between gap-x-6">
          <FilterPills
            label={t('filters.label')}
            param="action"
            pills={(['all', ...AUDIT_ACTIONS] as const).map((value) => ({
              value,
              label: value === 'all' ? t('filters.all') : t(`action.${value}`),
              count: format.number(page.counts[value]),
            }))}
          />
          <div className="mb-6 max-shell:mb-5">
            <SortSelect
              label={t('filters.user')}
              param="user"
              options={[
                { value: '', label: t('filters.everyone') },
                ...page.users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
              ]}
            />
          </div>
        </div>
      )}

      {state === 'list' && page && (
        <>
          <p
            className="mb-3 text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="audit-count"
          >
            {t('count', { count: page.total })}
          </p>
          <AuditTable rows={page.rows} names={page.names} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t('range', {
                from: format.number(from),
                to: format.number(from + page.rows.length - 1),
                total: page.total,
              })}
            </span>
            <Pagination
              params={{ page: page.page }}
              pages={page.pages}
              href={(n) => auditHref({ ...params, page: n })}
            />
          </div>
        </>
      )}
      {state === 'first' && (
        <EmptyState Icon={ScrollText} title={t('empty.first.title')} body={t('empty.first.body')}>
          <Button asChild>
            <Link href="/settings">{t('empty.first.back')}</Link>
          </Button>
        </EmptyState>
      )}
      {state === 'nomatch' && (
        <EmptyState Icon={Search} title={t('empty.noMatch.title')} body={t('empty.noMatch.body')}>
          <Button asChild>
            <Link href={auditHref({})}>{t('empty.noMatch.reset')}</Link>
          </Button>
        </EmptyState>
      )}
      {state === 'failed' && (
        <EmptyState
          tone="warning"
          Icon={TriangleAlert}
          title={t('empty.failed.title')}
          body={t('empty.failed.body')}
        >
          <RetryButton label={t('empty.failed.retry')} />
        </EmptyState>
      )}
    </>
  );
}
