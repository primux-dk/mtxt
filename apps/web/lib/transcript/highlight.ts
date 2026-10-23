/**
 * Keyterm highlighting for the transcript (figure 04): a term from the
 * install's list is marked where it stands as a whole word, in any case,
 * with æ, ø and å counted as letters. Longer terms win where two overlap,
 * so "linje 2" is one mark, not "linje" and a stray "2".
 */
export type Part = { text: string; mark: boolean };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex for a keyterm list, or null when there is nothing to mark. */
export function keytermPattern(terms: readonly string[]): RegExp | null {
  const unique = [
    ...new Set(terms.map((t) => t.trim().replace(/\s+/g, ' ')).filter((t) => t.length > 0)),
  ].sort((a, b) => b.length - a.length);
  if (!unique.length) return null;
  const alternatives = unique.map((t) => escape(t).replace(/ /g, '\\s+')).join('|');
  // Not after or before a letter, digit, mark or underscore: whole words in any script.
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives})(?![\\p{L}\\p{N}\\p{M}_])`,
    'giu',
  );
}

export function highlight(text: string, pattern: RegExp | null): Part[] {
  if (!pattern) return [{ text, mark: false }];
  const parts: Part[] = [];
  let last = 0;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > last) parts.push({ text: text.slice(last, at), mark: false });
    parts.push({ text: match[0], mark: true });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mark: false });
  return parts.length ? parts : [{ text, mark: false }];
}
