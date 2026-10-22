import { describe, expect, it } from 'vitest';
import { formatKeyterms, mergeKeyterms, parseKeyterms } from '../lib/settings/keyterms';

describe('parseKeyterms', () => {
  it('reads `term` and `term,boost` lines and skips blanks', () => {
    expect(parseKeyterms('Primux\n\nlinje 2,1.5\r\nugeplan\n')).toEqual({
      terms: [
        { term: 'Primux', boost: null },
        { term: 'linje 2', boost: 1.5 },
        { term: 'ugeplan', boost: null },
      ],
      errors: [],
    });
  });

  it('skips a header row and a byte order mark', () => {
    expect(parseKeyterms('﻿term,boost\nPrimux,2').terms).toEqual([{ term: 'Primux', boost: 2 }]);
  });

  it('reads quoted terms with commas and doubled quotes', () => {
    expect(parseKeyterms('"Acme, Inc.",3\n"The ""Line"" team"').terms).toEqual([
      { term: 'Acme, Inc.', boost: 3 },
      { term: 'The "Line" team', boost: null },
    ]);
  });

  it('reads a semicolon file with a decimal comma', () => {
    expect(parseKeyterms('Ærøskøbing;1,5\nÅbenrå').terms).toEqual([
      { term: 'Ærøskøbing', boost: 1.5 },
      { term: 'Åbenrå', boost: null },
    ]);
  });

  it('keeps the first spelling of a repeated term', () => {
    expect(parseKeyterms('Primux\nPRIMUX,2').terms).toEqual([{ term: 'Primux', boost: null }]);
  });

  it('reports a bad weight and an extra column with the line number', () => {
    expect(parseKeyterms('Primux\nlinje 2,abc').errors).toEqual([
      { code: 'badBoost', record: 2, value: 'abc', max: 10 },
    ]);
    expect(parseKeyterms('a,1\nb,0').errors[0]).toMatchObject({ code: 'badBoost', record: 2 });
    expect(parseKeyterms('a,1,x').errors).toEqual([{ code: 'tooManyFields', record: 1 }]);
  });

  it('reads quoted fields that span lines, doubled quotes and CRLF', () => {
    expect(parseKeyterms('"Acme\r\nNordic",2\r\n"Say ""hi""",1\r\nugeplan')).toEqual({
      terms: [
        { term: 'Acme\r\nNordic', boost: 2 },
        { term: 'Say "hi"', boost: 1 },
        { term: 'ugeplan', boost: null },
      ],
      errors: [],
    });
  });

  it('refuses an unterminated quote by record and imports nothing', () => {
    expect(parseKeyterms('Primux\nlinje 2\n"Acme, Inc.,2\nugeplan')).toEqual({
      terms: [],
      errors: [{ code: 'unterminatedQuote', record: 3 }],
    });
  });

  it('refuses a record with three fields and imports nothing', () => {
    expect(parseKeyterms('Primux\n"two\nlines",1\na,1,x')).toEqual({
      terms: [],
      errors: [{ code: 'tooManyFields', record: 4 }],
    });
  });

  it('refuses three fields even when the third is empty', () => {
    expect(parseKeyterms('Primux\nalpha,2,')).toEqual({
      terms: [],
      errors: [{ code: 'tooManyFields', record: 2 }],
    });
  });

  it('round-trips a term with a line break, a comma and a quote', () => {
    const imported = parseKeyterms('"alpha\nbeta",2\n"Acme, ""Nordic""",1');
    expect(imported.terms).toEqual([
      { term: 'alpha\nbeta', boost: 2 },
      { term: 'Acme, "Nordic"', boost: 1 },
    ]);
    const text = formatKeyterms(imported.terms);
    expect(text).toBe('"alpha\nbeta",2\n"Acme, ""Nordic""",1');
    expect(parseKeyterms(text).terms).toEqual(imported.terms);
  });

  it('reports a term over 100 characters and a list over 1000 terms', () => {
    expect(parseKeyterms('x'.repeat(101)).errors).toEqual([
      { code: 'termTooLong', record: 1, max: 100 },
    ]);
    const many = Array.from({ length: 1001 }, (_, i) => `term ${i}`).join('\n');
    expect(parseKeyterms(many).errors).toEqual([{ code: 'tooMany', max: 1000 }]);
  });
});

describe('formatKeyterms and mergeKeyterms', () => {
  it('round-trips through the textarea format', () => {
    const terms = [
      { term: 'Acme, Inc.', boost: 3 },
      { term: 'Primux', boost: null },
    ];
    expect(formatKeyterms(terms)).toBe('"Acme, Inc.",3\nPrimux');
    expect(parseKeyterms(formatKeyterms(terms)).terms).toEqual(terms);
  });

  it('adds imported terms after the current ones and skips terms already there', () => {
    expect(
      mergeKeyterms(
        [{ term: 'Primux', boost: null }],
        [
          { term: 'primux', boost: 2 },
          { term: 'ugeplan', boost: null },
        ],
      ),
    ).toEqual([
      { term: 'Primux', boost: null },
      { term: 'ugeplan', boost: null },
    ]);
  });
});
