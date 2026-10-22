/** The library's state, all of it in the URL (behaviour.md rule 5). */
export const VIEWS = ['mine', 'shared', 'company', 'archived'] as const;
export const STATUS_FILTERS = ['ready', 'transcribing', 'failed'] as const;
/** `relevance` is the default, and only possible, order of a search (packet 6). */
export const SORTS = ['date', 'title', 'relevance'] as const;
export const PAGE_SIZE = 25;

export type View = (typeof VIEWS)[number];
export type StatusFilter = (typeof STATUS_FILTERS)[number];
export type Sort = (typeof SORTS)[number];

export interface LibraryParams {
  view: View;
  /** Title search, trimmed; undefined when empty. */
  q?: string;
  status?: StatusFilter;
  sort: Sort;
  /** 1-based. */
  page: number;
}

type Raw = Record<string, string | string[] | undefined> | URLSearchParams;

const pick = <T extends string>(values: readonly T[], value: string | undefined) =>
  values.find((v) => v === value);

/**
 * Reads the library's URL. Anything unknown falls back to the default, so
 * an edited or stale link still opens the library rather than an error.
 */
export function parseLibraryParams(raw: Raw): LibraryParams {
  const get = (key: string) => {
    const value = raw instanceof URLSearchParams ? (raw.get(key) ?? undefined) : raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const q = get('q')?.trim().slice(0, 200) || undefined;
  const page = Number(get('page'));
  const sort = pick(SORTS, get('sort'));
  return {
    view: pick(VIEWS, get('view')) ?? 'mine',
    q,
    status: pick(STATUS_FILTERS, get('status')),
    sort: sort && (sort !== 'relevance' || q) ? sort : defaultSort(q),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 100_000) : 1,
  };
}

/** A search ranks by relevance; the plain library lists newest first. */
export const defaultSort = (q: string | undefined): Sort => (q ? 'relevance' : 'date');

/** The URL for a library state. Defaults are left out, so links stay short. */
export function libraryHref(params: Partial<LibraryParams>): string {
  const search = new URLSearchParams();
  if (params.view && params.view !== 'mine') search.set('view', params.view);
  if (params.q) search.set('q', params.q);
  if (params.status) search.set('status', params.status);
  if (params.sort && params.sort !== defaultSort(params.q)) search.set('sort', params.sort);
  if (params.page && params.page > 1) search.set('page', String(params.page));
  const query = search.toString();
  return query ? `/meetings?${query}` : '/meetings';
}

/** Whether a search or filter narrows the list: empty then means "no match", not "first use". */
export const isFiltered = (params: LibraryParams) => Boolean(params.q || params.status);

/** Page numbers to show: first, last, and two either side of the current one. */
export function pageWindow(current: number, pages: number): (number | 'gap')[] {
  const shown = new Set([1, pages, current - 2, current - 1, current, current + 1, current + 2]);
  const list = [...shown].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (const n of list) {
    const last = out.at(-1);
    if (typeof last === 'number' && n - last > 1) out.push('gap');
    out.push(n);
  }
  return out;
}

/** The longest a `?t=` link may point: 24 hours, in seconds. */
export const MAX_START_AT = 86_400;

/**
 * `?t=1834` on a meeting link: whole seconds from 0 to 24 hours. Anything
 * else (a fraction, a sign, 400 digits) is ignored, never passed to the player.
 */
export function parseStartAt(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,5}$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds <= MAX_START_AT ? seconds : undefined;
}
