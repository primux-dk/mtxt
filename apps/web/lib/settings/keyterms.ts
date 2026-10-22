/*
  Keyterms as text: one per line, `term` or `term,boost`. The textarea on the
  settings page and a CSV import read the same way, so an exported sheet can
  be pasted or imported. A spreadsheet saved with semicolons (Danish Excel)
  works too, with a decimal comma in the weight.
*/

export const MAX_TERMS = 1000;
export const MAX_TERM_LENGTH = 100;
export const MAX_BOOST = 10;

export interface Keyterm {
  term: string;
  boost: number | null;
}

export type KeytermError =
  | { code: 'termTooLong'; line: number; max: number }
  | { code: 'badBoost'; line: number; value: string; max: number }
  | { code: 'tooManyFields'; line: number }
  | { code: 'tooMany'; max: number };

/** Splits one CSV line on `separator`, honouring double quotes. */
function splitLine(line: string, separator: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === separator) {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/** Semicolons when any line has one outside quotes (a comma may then be a decimal comma), else commas. */
function detectSeparator(lines: string[]): string {
  return lines.some((line) => line.replace(/"(?:[^"]|"")*"/g, '').includes(';')) ? ';' : ',';
}

const HEADER = /^(term|keyterm|keyterms|nøgleord)$/i;

/**
 * Parses keyterm lines. Blank lines are skipped, a `term` or `term,boost`
 * header row is skipped, and a term repeated with other casing keeps its
 * first spelling. Errors carry the 1-based line number.
 */
export function parseKeyterms(text: string): { terms: Keyterm[]; errors: KeytermError[] } {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const separator = detectSeparator(lines);
  const terms: Keyterm[] = [];
  const errors: KeytermError[] = [];
  const seen = new Set<string>();

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return;
    const fields = splitLine(raw, separator);
    const [term = '', boostText = '', ...rest] = fields;
    if (!term) return;
    if (index === lines.findIndex((l) => l.trim()) && HEADER.test(term)) return;
    if (rest.some((f) => f !== '')) {
      errors.push({ code: 'tooManyFields', line });
      return;
    }
    if (term.length > MAX_TERM_LENGTH) {
      errors.push({ code: 'termTooLong', line, max: MAX_TERM_LENGTH });
      return;
    }
    let boost: number | null = null;
    if (boostText) {
      const value = Number(separator === ';' ? boostText.replace(',', '.') : boostText);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_BOOST) {
        errors.push({ code: 'badBoost', line, value: boostText, max: MAX_BOOST });
        return;
      }
      boost = value;
    }
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ term, boost });
  });

  if (terms.length > MAX_TERMS) errors.push({ code: 'tooMany', max: MAX_TERMS });
  return { terms, errors };
}

const quote = (value: string) => (/[",;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** Back to the textarea's format, one line per term. */
export function formatKeyterms(terms: readonly Keyterm[]): string {
  return terms
    .map((t) => (t.boost == null ? quote(t.term) : `${quote(t.term)},${t.boost}`))
    .join('\n');
}

/** Adds imported terms after the existing ones; a term already in the list keeps its line. */
export function mergeKeyterms(
  current: readonly Keyterm[],
  imported: readonly Keyterm[],
): Keyterm[] {
  const seen = new Set(current.map((t) => t.term.toLocaleLowerCase()));
  return [...current, ...imported.filter((t) => !seen.has(t.term.toLocaleLowerCase()))];
}
