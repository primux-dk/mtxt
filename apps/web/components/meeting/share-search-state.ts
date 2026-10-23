import type { Colleague } from '@/lib/meetings/queries';

export type SearchState =
  | { state: 'idle' | 'loading' | 'failed' }
  /**
   * `others`: the directory holds someone besides the signed-in user.
   * `addable`: how many of them do not have access yet, over the whole directory.
   */
  | { state: 'done'; found: Colleague[]; others: boolean; addable: number };

/** The line under the share dialog's search field, as a key under `share.search`. */
export type SearchLine = 'saving' | 'loading' | 'alone' | 'everyone' | 'none' | null;

/**
 * Which line the share dialog shows under its search: three different reasons
 * for an empty result are three different lines. No one else has signed in
 * yet; everyone else has access already; or the text matches no colleague.
 * A failed search shows its own alert instead, and a list of colleagues needs
 * no line.
 */
export function searchLine({
  ready,
  search,
  text,
  candidates,
}: {
  /** The meeting is `shared` on the server. */
  ready: boolean;
  search: SearchState;
  text: string;
  /** The found colleagues who do not have access yet. */
  candidates: number;
}): SearchLine {
  if (!ready) return 'saving';
  if (search.state === 'loading') return 'loading';
  if (search.state !== 'done' || candidates > 0) return null;
  if (!search.others) return 'alone';
  if (text.trim()) return 'none';
  // Counted over the whole directory, not the capped list: 20 readers in a list of 46 are not everyone.
  return search.addable === 0 ? 'everyone' : null;
}
