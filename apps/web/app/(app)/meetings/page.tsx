import { Archive, CalendarDays, Download, Mic, Search, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { EmptyState } from '@/components/library/empty-state';
import { FilterPills } from '@/components/library/filter-pills';
import { Pagination } from '@/components/library/pagination';
import { RetryButton } from '@/components/library/retry-button';
import { ScrollMemory } from '@/components/library/scroll-memory';
import { SearchBox } from '@/components/library/search-box';
import { SortSelect } from '@/components/library/sort-select';
import { MeetingList } from '@/components/meetings/meeting-list';
import { PageTitle } from '@/components/page-title';
import { Button } from '@/components/ui/button';
import { NewMeetingMenu, UploadButton } from '@/components/upload/new-meeting-menu';
import { getAdapters, getInstallSettings } from '@/lib/install';
import {
  isFiltered,
  libraryHref,
  PAGE_SIZE,
  parseLibraryParams,
  STATUS_FILTERS,
  type View,
} from '@/lib/meetings/library-params';
import { countArchived, listMeetings, type LibraryPage } from '@/lib/meetings/queries';
import { requireUser } from '@/lib/auth/session';
import { isTestMode } from '@/lib/test-mode';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TITLES: Record<View, ['nav' | 'library', string]> = {
  mine: ['nav', 'myMeetings'],
  shared: ['nav', 'sharedWithMe'],
  company: ['nav', 'wholeCompany'],
  archived: ['library', 'archived.title'],
};

/*
  The library: My meetings, Shared with me, Whole company and Archived are
  one page with `view`. Its whole state is in the URL (behaviour.md rule 5):
  /meetings?view=shared&q=budget&status=ready&sort=title&page=2. A count and
  page links end the list (rule 6). The three empty states are real
  conditions (rule 8); in AUTH_TEST_MODE `?state=failed` forces the failure
  so the e2e test can see it.
*/
export default async function MeetingsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = parseLibraryParams(raw);
  const [user, t, ts, nav, format, settings, testMode] = await Promise.all([
    requireUser(),
    getTranslations('library'),
    getTranslations('search'),
    getTranslations('nav'),
    getFormatter(),
    getInstallSettings(),
    isTestMode(),
  ]);
  const canUpload = settings.recordingSources.includes('upload');
  const canRecord = settings.recordingSources.includes('browser');

  let page: LibraryPage | null = null;
  let archivedCount = 0;
  try {
    if (testMode && raw.state === 'failed') throw new Error('Forced by ?state=failed');
    const { db, installId } = await getAdapters();
    [page, archivedCount] = await Promise.all([
      listMeetings(db, installId, user, params),
      params.view === 'archived' ? 0 : countArchived(db, installId, user),
    ]);
  } catch (error) {
    console.error('Could not load the library', error);
  }

  const [ns, key] = TITLES[params.view];
  const title = ns === 'nav' ? nav(key as 'myMeetings') : t(key as 'archived.title');
  const state = !page
    ? 'failed'
    : page.total > 0
      ? 'list'
      : isFiltered(params)
        ? 'nomatch'
        : 'first';
  const from = page ? (page.page - 1) * PAGE_SIZE + 1 : 0;
  const search = (className: string) => (
    <SearchBox
      action="/meetings"
      defaultValue={params.q}
      label={t('search.label')}
      placeholder={t('search.placeholder')}
      className={className}
      hidden={{
        view: params.view === 'mine' ? undefined : params.view,
        status: params.status,
        // A new search ranks by relevance unless the reader sorted by title.
        sort: params.sort === 'title' ? 'title' : undefined,
      }}
    />
  );

  return (
    <>
      <ScrollMemory />
      {/*
        The header is two rows on a desktop: the title with search, Upload
        audio and the one primary; then the pills with the Archived link, and
        the count with the sort. On a phone it is four: title and New meeting,
        search, pills, count and sort. The search is rendered in both places
        and hidden by width, so the tab order follows the layout either way
        (behaviour.md rule 11); a hidden copy is out of the tab order and the
        accessibility tree.
      */}
      <div className="mb-4">
        <PageTitle
          title={title}
          action={
            <div className="flex flex-wrap items-center gap-3">
              {search('w-80 max-w-full min-[1440px]:w-[420px] max-shell:hidden')}
              {canUpload && <UploadButton label={t('uploadAudio')} className="max-shell:hidden" />}
              <NewMeetingMenu
                label={t('newMeeting')}
                recordLabel={t('newMeetingMenu.record')}
                uploadLabel={t('newMeetingMenu.upload')}
                canRecord={canRecord}
                canUpload={canUpload}
              />
            </div>
          }
        />
      </div>
      {search('mb-4 w-full shell:hidden')}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 max-shell:flex-col max-shell:flex-nowrap max-shell:items-stretch max-shell:gap-4">
        <div className="flex min-w-0 items-center gap-6 max-shell:-mx-5 max-shell:-my-1 max-shell:overflow-x-auto max-shell:px-5 max-shell:py-1 max-shell:[scrollbar-width:none]">
          <FilterPills
            label={t('filters.label')}
            param="status"
            className="max-shell:flex-nowrap"
            pills={(['all', ...STATUS_FILTERS] as const).map((value) => ({
              value,
              label: t(`filter.${value}`),
              count: page ? format.number(page.counts[value]) : undefined,
            }))}
          />
          {/* Archived is a view of its own, so the link swaps for the way back inside it. */}
          <Link
            href={params.view === 'archived' ? '/meetings' : '/meetings?view=archived'}
            className="inline-flex min-h-10 shrink-0 items-center gap-1.5 text-sm whitespace-nowrap text-muted-foreground underline-offset-4 hover:underline max-shell:min-h-11"
          >
            {params.view === 'archived' ? (
              t('archived.back')
            ) : (
              <>
                {t('archived.link')}
                {/* A space, so the accessible name reads "Archived 3", not "Archived3". */}
                {archivedCount > 0 && ' '}
                {archivedCount > 0 && (
                  <span className="tabular-nums">{format.number(archivedCount)}</span>
                )}
              </>
            )}
          </Link>
        </div>
        {state === 'list' && page && (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span aria-live="polite" data-testid="result-count">
              {t('count', { count: page.total })}
            </span>
            <SortSelect
              label={t('sort.label')}
              options={[
                ...(params.q ? [{ value: 'relevance', label: ts('sort.relevance') }] : []),
                { value: 'date', label: t('sort.newest') },
                { value: 'title', label: t('sort.title') },
              ]}
            />
          </div>
        )}
      </div>

      {state === 'list' && page && (
        <>
          <MeetingList rows={page.rows} restore={params.view === 'archived'} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {t('range', {
                from: format.number(from),
                to: format.number(from + page.rows.length - 1),
                total: page.total,
              })}
            </span>
            <Pagination params={{ ...params, page: page.page }} pages={page.pages} />
          </div>
        </>
      )}

      {state === 'first' && params.view === 'mine' && (
        <EmptyState Icon={CalendarDays} title={t('empty.first.title')} body={t('empty.first.body')}>
          <Button disabled title={t('empty.first.downloadSoon')}>
            <Download aria-hidden="true" />
            {t('empty.first.download')}
          </Button>
          {canUpload && <UploadButton label={t('empty.first.upload')} />}
          {canRecord && (
            <Button asChild>
              <Link href="/meetings/new">
                <Mic aria-hidden="true" />
                {t('empty.first.record')}
              </Link>
            </Button>
          )}
        </EmptyState>
      )}
      {state === 'first' && params.view !== 'mine' && (
        <EmptyState
          Icon={params.view === 'archived' ? Archive : CalendarDays}
          title={t(`empty.${params.view}.title`)}
          body={t(`empty.${params.view}.body`)}
        >
          <Button asChild>
            <Link href="/meetings">{nav('myMeetings')}</Link>
          </Button>
        </EmptyState>
      )}
      {state === 'nomatch' && (
        <EmptyState
          Icon={Search}
          title={t('empty.noMatch.title')}
          body={params.q ? ts('empty.body', { q: params.q }) : t('empty.noMatch.body')}
        >
          <Button asChild>
            <Link href={libraryHref({ view: params.view, sort: params.sort })}>
              {t('empty.noMatch.reset')}
            </Link>
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
