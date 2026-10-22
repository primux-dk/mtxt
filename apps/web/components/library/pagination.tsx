import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { cn } from 'cn';
import { libraryHref, pageWindow, type LibraryParams } from '@/lib/meetings/library-params';

/**
 * Page links with the page in the URL (behaviour.md rule 6). Plain links, so
 * Back works. The library passes its params; another list passes `page` and
 * its own `href`.
 */
export async function Pagination({
  params,
  pages,
  href: hrefFor,
}: {
  params: Pick<LibraryParams, 'page'> & Partial<LibraryParams>;
  pages: number;
  href?: (page: number) => string;
}) {
  const t = await getTranslations('library.pagination');
  if (pages <= 1) return null;
  const href = hrefFor ?? ((page: number) => libraryHref({ ...params, page }));
  const step =
    'inline-flex min-h-10 items-center gap-1 rounded-control border border-input bg-card px-3 text-sm hover:bg-secondary max-shell:min-h-11';
  return (
    <nav aria-label={t('label')} className="flex flex-wrap items-center gap-1.5">
      {params.page > 1 && (
        <Link href={href(params.page - 1)} className={step} rel="prev">
          <ChevronLeft aria-hidden="true" className="size-4" strokeWidth={1.5} />
          {t('previous')}
        </Link>
      )}
      <ul className="flex flex-wrap items-center gap-1.5">
        {pageWindow(params.page, pages).map((n, i) =>
          n === 'gap' ? (
            <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-muted-foreground">
              …
            </li>
          ) : (
            <li key={n}>
              <Link
                href={href(n)}
                aria-label={t('page', { page: n })}
                aria-current={n === params.page ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-10 min-w-10 items-center justify-center rounded-control border border-transparent px-2 text-sm tabular-nums hover:bg-secondary max-shell:min-h-11 max-shell:min-w-11',
                  n === params.page &&
                    'border-accent-line-control bg-accent-tint text-accent-foreground',
                )}
              >
                {n}
              </Link>
            </li>
          ),
        )}
      </ul>
      {params.page < pages && (
        <Link href={href(params.page + 1)} className={step} rel="next">
          {t('next')}
          <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </Link>
      )}
    </nav>
  );
}
