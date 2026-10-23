import { describe, expect, it } from 'vitest';
import { highlight, keytermPattern } from '../lib/transcript/highlight';

const marked = (text: string, terms: string[]) =>
  highlight(text, keytermPattern(terms))
    .filter((p) => p.mark)
    .map((p) => p.text);

describe('keyterm highlighting', () => {
  it('marks whole words in any case, æ, ø and å included', () => {
    expect(marked('Vi tager ÆRØ og ærø i ugeplanen', ['Ærø', 'ugeplanen'])).toEqual([
      'ÆRØ',
      'ærø',
      'ugeplanen',
    ]);
  });

  it('leaves a term inside a longer word alone, also at æ, ø and å', () => {
    expect(marked('ugeplanen og planlægning', ['plan'])).toEqual([]);
    expect(marked('Ærøskøbing og Ærø', ['Ærø'])).toEqual(['Ærø']);
    expect(marked('søren, Søren! sørens', ['Søren'])).toEqual(['søren', 'Søren']);
  });

  it('prefers the longer of two overlapping terms', () => {
    expect(marked('kapaciteten på linje 2 og linje 3', ['linje', 'linje 2'])).toEqual([
      'linje 2',
      'linje',
    ]);
  });

  it('matches a multi-word term across any whitespace and takes regex characters literally', () => {
    expect(marked('linje\n2 og C++ og a.b', ['linje 2', 'C++', 'a.b'])).toEqual([
      'linje\n2',
      'C++',
      'a.b',
    ]);
    expect(marked('axb', ['a.b'])).toEqual([]);
  });

  it('keeps the text whole and in order', () => {
    const parts = highlight('Hej linje 2.', keytermPattern(['linje 2']));
    expect(parts).toEqual([
      { text: 'Hej ', mark: false },
      { text: 'linje 2', mark: true },
      { text: '.', mark: false },
    ]);
    expect(highlight('Hej', keytermPattern([]))).toEqual([{ text: 'Hej', mark: false }]);
  });
});
