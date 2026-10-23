import { describe, expect, it } from 'vitest';
import { diffStats, formatDiff, wordDiff, words } from '../lib/stt/compare';

describe('the comparison diff', () => {
  it('counts words without punctuation', () => {
    expect(words('Så er vi samlet. Linje 2, ikke?')).toEqual([
      'Så',
      'er',
      'vi',
      'samlet',
      'Linje',
      '2',
      'ikke',
    ]);
    expect(words('  ')).toEqual([]);
  });

  it('finds the words one transcript has and the other lacks, ignoring case', () => {
    const a = words('Lad os begynde med kapaciteten på linje 2');
    const b = words('lad os starte med kapaciteten på linie 2 i dag');
    const parts = wordDiff(a, b);
    expect(formatDiff(parts)).toBe(
      'Lad os [-begynde-] {+starte+} med kapaciteten på [-linje-] {+linie+} 2 {+i dag+}',
    );
    expect(diffStats(parts)).toEqual({ same: 6, removed: 2, added: 4 });
  });

  it('handles empty sides and equal texts', () => {
    expect(wordDiff([], ['a'])).toEqual([{ kind: 'added', words: ['a'] }]);
    expect(wordDiff(['a'], [])).toEqual([{ kind: 'removed', words: ['a'] }]);
    expect(wordDiff(['a', 'b'], ['A', 'b'])).toEqual([{ kind: 'same', words: ['a', 'b'] }]);
    expect(wordDiff([], [])).toEqual([]);
  });

  it('shortens long runs of the same words', () => {
    const same = Array.from({ length: 30 }, (_, i) => `w${i}`);
    expect(formatDiff(wordDiff([...same, 'x'], [...same, 'y']))).toBe(
      'w0 w1 w2 w3 w4 w5 … w24 w25 w26 w27 w28 w29 [-x-] {+y+}',
    );
  });
});

describe('the diff against a plain LCS', () => {
  it('agrees on random word lists', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const list = () =>
      Array.from({ length: Math.floor(rand() * 12) }, () => 'abc'[Math.floor(rand() * 3)]!);
    for (let run = 0; run < 300; run++) {
      const a = list();
      const b = list();
      const parts = wordDiff(a, b);
      const back = (kind: 'removed' | 'added') =>
        parts.filter((p) => p.kind === 'same' || p.kind === kind).flatMap((p) => p.words);
      expect(back('removed')).toEqual(a);
      expect(back('added')).toEqual(b);
      // Same words are a longest common subsequence.
      const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array<number>(b.length + 1).fill(0),
      );
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          lcs[i]![j] =
            a[i - 1] === b[j - 1]
              ? lcs[i - 1]![j - 1]! + 1
              : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
      expect(diffStats(parts).same).toBe(lcs[a.length]![b.length]);
    }
  });
});
