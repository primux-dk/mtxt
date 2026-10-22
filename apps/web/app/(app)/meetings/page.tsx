import { Download, CalendarDays, Plus, Search, TriangleAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/library/empty-state';
import { FilterPills } from '@/components/library/filter-pills';
import { RetryButton } from '@/components/library/retry-button';
import { SearchBox } from '@/components/library/search-box';
import { PageTitle } from '@/components/page-title';
import { Button } from '@/components/ui/button';

type View = 'mine' | 'shared' | 'company';
const VIEWS: Record<View, { title: 'myMeetings' | 'sharedWithMe' | 'wholeCompany' }> = {
  mine: { title: 'myMeetings' },
  shared: { title: 'sharedWithMe' },
  company: { title: 'wholeCompany' },
};
const FILTERS = ['all', 'thisWeek', 'private', 'shared'] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/*
  The library. Its state lives in the URL (behaviour.md rule 5):
  /meetings?view=shared&q=budget&filter=private. There are no meetings until
  upload lands, so the page shows one of the three empty states (rule 8).
  `?state=nomatch` and `?state=failed` force the other two until real data
  can produce them.
*/
export default async function MeetingsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const view: View =
    one(params.view) === 'shared' || one(params.view) === 'company'
      ? (one(params.view) as View)
      : 'mine';
  const q = one(params.q)?.trim() || undefined;
  const filter = one(params.filter);
  const forced = one(params.state);

  const t = await getTranslations('library');
  const nav = await getTranslations('nav');
  const format = await getFormatter();

  // No meetings exist yet, so any search or filter is "no match".
  const state =
    forced === 'failed'
      ? 'failed'
      : forced === 'nomatch' || q || (filter && filter !== 'all')
        ? 'nomatch'
        : 'first';
  const viewHref = view === 'mine' ? '/meetings' : `/meetings?view=${view}`;

  return (
    <>
      <div className="mb-8 flex items-center justify-between gap-3 max-shell:mb-6">
        <SearchBox
          action="/meetings"
          defaultValue={q}
          label={t('search.label')}
          placeholder={t('search.placeholder')}
          hidden={{ view: view === 'mine' ? undefined : view }}
        />
        <Button className="max-shell:hidden">
          <Upload aria-hidden="true" />
          {t('uploadAudio')}
        </Button>
      </div>

      <div className="mt-8 mb-6 max-shell:mt-6">
        <PageTitle
          title={nav(VIEWS[view].title)}
          subheading={t(`${view}.subheading`)}
          action={
            <Button variant="primary" className="max-shell:px-3 max-shell:text-xs">
              <Plus aria-hidden="true" />
              {t('newMeeting')}
            </Button>
          }
        />
      </div>

      <FilterPills
        label={t('filters.label')}
        pills={FILTERS.map((value) => ({
          value,
          label: t(`filter.${value}`),
          count: state === 'failed' ? undefined : format.number(0),
        }))}
      />

      {state === 'first' && (
        <EmptyState Icon={CalendarDays} title={t('empty.first.title')} body={t('empty.first.body')}>
          <Button>
            <Download aria-hidden="true" />
            {t('empty.first.download')}
          </Button>
          <Button>
            <Upload aria-hidden="true" />
            {t('empty.first.upload')}
          </Button>
        </EmptyState>
      )}
      {state === 'nomatch' && (
        <EmptyState Icon={Search} title={t('empty.noMatch.title')} body={t('empty.noMatch.body')}>
          <Button asChild>
            <Link href={viewHref}>{t('empty.noMatch.reset')}</Link>
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
      <p className="sr-only" aria-live="polite">
        {state === 'failed' ? '' : t('count', { count: 0 })}
      </p>
    </>
  );
}
