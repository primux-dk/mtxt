/*
  The comparison tool's text work (scripts/stt-compare.ts): word counts and
  a word-level diff of two transcripts. Words are compared lower-cased and
  without punctuation, so "Linje 2." and "linje 2" are the same words.
*/
export const words = (text: string) =>
  text
    .normalize('NFKC')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);

const key = (word: string) => word.toLocaleLowerCase();

/** Past this many differing words the diff gives up; the word counts still print. */
export const MAX_EDITS = 6000;

export type DiffPart = { kind: 'same' | 'removed' | 'added'; words: string[] };

/**
 * Myers' O(ND) diff on words: fast when the two texts are close, which two
 * transcripts of the same recording are.
 */
export function wordDiff(a: readonly string[], b: readonly string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // v[o + k] is the furthest x on diagonal k; one cell of padding either side.
  const o = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Each step keeps only the diagonals it can reach, so memory grows with d², not d·(n+m).
  const trace: Int32Array[] = [];
  const at = (d: number, k: number) => trace[d]![k + d + 1]!;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    if (d > MAX_EDITS) throw new Error(`The transcripts differ in more than ${MAX_EDITS} words.`);
    trace.push(v.slice(o - d - 1, o + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[o + k - 1]! < v[o + k + 1]!);
      let x = down ? v[o + k + 1]! : v[o + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && key(a[x]!) === key(b[y]!)) {
        x++;
        y++;
      }
      v[o + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Walk back through the trace to the edit script.
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], word: string) => {
    const first = parts[0];
    if (first?.kind === kind) first.words.unshift(word);
    else parts.unshift({ kind, words: [word] });
  };
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const down = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      push('same', a[x]!);
    }
    if (d === 0) break;
    if (x === prevX) push('added', b[prevY]!);
    else push('removed', a[prevX]!);
    x = prevX;
    y = prevY;
  }
  return parts;
}

/** git's word-diff notation: [-removed-] {+added+}, long runs of the same words shortened. */
export function formatDiff(parts: readonly DiffPart[], context = 6): string {
  return parts
    .map((p) => {
      if (p.kind === 'removed') return `[-${p.words.join(' ')}-]`;
      if (p.kind === 'added') return `{+${p.words.join(' ')}+}`;
      if (p.words.length <= context * 2) return p.words.join(' ');
      return `${p.words.slice(0, context).join(' ')} … ${p.words.slice(-context).join(' ')}`;
    })
    .join(' ');
}

export function diffStats(parts: readonly DiffPart[]) {
  const count = (kind: DiffPart['kind']) =>
    parts.filter((p) => p.kind === kind).reduce((n, p) => n + p.words.length, 0);
  return { same: count('same'), removed: count('removed'), added: count('added') };
}
