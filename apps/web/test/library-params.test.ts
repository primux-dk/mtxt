import { describe, expect, it } from 'vitest';
import {
  isFiltered,
  libraryHref,
  pageWindow,
  parseLibraryParams,
} from '../lib/meetings/library-params';

describe('parseLibraryParams', () => {
  it('reads every part of the library URL', () => {
    expect(
      parseLibraryParams(
        new URLSearchParams('view=shared&q=%20budget%20&status=ready&sort=title&page=3'),
      ),
    ).toEqual({ view: 'shared', q: 'budget', status: 'ready', sort: 'title', page: 3 });
  });

  it('falls back to the defaults for anything unknown or broken', () => {
    expect(
      parseLibraryParams({
        view: 'everything',
        status: 'done',
        sort: 'size',
        page: '-2',
        q: '   ',
      }),
    ).toEqual({
      view: 'mine',
      q: undefined,
      status: undefined,
      sort: 'date',
      page: 1,
    });
    expect(parseLibraryParams({ page: '2.5' }).page).toBe(1);
    expect(parseLibraryParams({ page: ['4', '5'] }).page).toBe(4);
  });

  it('round-trips through libraryHref, leaving defaults out', () => {
    const params = parseLibraryParams({
      view: 'company',
      q: 'møde & co',
      status: 'failed',
      page: '2',
    });
    expect(parseLibraryParams(new URL(libraryHref(params), 'http://x').searchParams)).toEqual(
      params,
    );
    expect(libraryHref({ view: 'mine', sort: 'date', page: 1 })).toBe('/meetings');
  });

  it('ranks a search by relevance unless asked otherwise, and never a plain list', () => {
    expect(parseLibraryParams({ q: 'budget' }).sort).toBe('relevance');
    expect(parseLibraryParams({ q: 'budget', sort: 'date' }).sort).toBe('date');
    expect(parseLibraryParams({ sort: 'relevance' }).sort).toBe('date');
    expect(libraryHref({ q: 'budget', sort: 'relevance' })).toBe('/meetings?q=budget');
    expect(libraryHref({ q: 'budget', sort: 'date' })).toBe('/meetings?q=budget&sort=date');
    // Resetting a search keeps no relevance order behind.
    expect(libraryHref({ view: 'mine', sort: 'relevance' })).toBe('/meetings');
  });

  it('tells a narrowed list from a full one', () => {
    expect(isFiltered(parseLibraryParams({ q: 'x' }))).toBe(true);
    expect(isFiltered(parseLibraryParams({ status: 'ready' }))).toBe(true);
    expect(isFiltered(parseLibraryParams({ sort: 'title', page: '3' }))).toBe(false);
  });
});

describe('pageWindow', () => {
  it('shows the ends and the neighbourhood, with gaps', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 'gap', 5]);
    expect(pageWindow(40, 80)).toEqual([1, 'gap', 38, 39, 40, 41, 42, 'gap', 80]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('parseStartAt', () => {
  it('takes whole seconds from 0 to 24 hours and ignores the rest', async () => {
    const { parseStartAt } = await import('../lib/meetings/library-params');
    expect(parseStartAt('0')).toBe(0);
    expect(parseStartAt('1834')).toBe(1834);
    expect(parseStartAt('86400')).toBe(86_400);
    for (const raw of ['86401', '-1', '1.5', '1e3', '9'.repeat(400), '', undefined]) {
      expect(parseStartAt(raw), String(raw).slice(0, 10)).toBeUndefined();
    }
  });
});
