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
