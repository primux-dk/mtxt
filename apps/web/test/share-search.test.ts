import { describe, expect, it } from 'vitest';
import { searchLine, type SearchState } from '../components/meeting/share-search-state';

const anne = { id: 'anne', name: 'Anne Holm', email: 'anne.holm@example.com' };
const done = (others: boolean, found = others ? [anne] : []): SearchState => ({
  state: 'done',
  found,
  others,
});
const line = (over: Partial<Parameters<typeof searchLine>[0]>) =>
  searchLine({ ready: true, search: done(true), text: '', candidates: 0, ...over });

describe('the line under the share search (packet 12)', () => {
  it('says no one else has signed in when the directory holds only the user', () => {
    expect(line({ search: done(false) })).toBe('alone');
    // A search changes nothing: there is no one to match.
    expect(line({ search: done(false), text: 'anne' })).toBe('alone');
  });

  it('says everyone has access when others exist and all of them are readers', () => {
    expect(line({ search: done(true), candidates: 0 })).toBe('everyone');
    expect(line({ search: done(true), text: '   ', candidates: 0 })).toBe('everyone');
  });

  it('says no colleague matches when a search finds no one to add', () => {
    expect(line({ search: done(true, []), text: 'zz', candidates: 0 })).toBe('none');
  });

  it('shows nothing while there are colleagues to add, or when the search failed', () => {
    expect(line({ candidates: 1 })).toBeNull();
    expect(line({ text: 'an', candidates: 1 })).toBeNull();
    expect(line({ search: { state: 'failed' } })).toBeNull();
    expect(line({ search: { state: 'idle' } })).toBeNull();
  });

  it('waits for the visibility to save, then for the search', () => {
    expect(line({ ready: false, search: done(false) })).toBe('saving');
    expect(line({ search: { state: 'loading' } })).toBe('loading');
  });
});
