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
  | { code: 'termTooLong'; record: number; max: number }
  | { code: 'badBoost'; record: number; value: string; max: number }
  | { code: 'tooManyFields'; record: number }
  | { code: 'unterminatedQuote'; record: number }
  | { code: 'tooMany'; max: number };

/** Semicolons when the text has one outside quotes (a comma may then be a decimal comma), else commas. */
function detectSeparator(text: string): string {
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (c === ';' && !quoted) return ';';
  }
  return ',';
}

interface CsvRecord {
  /** 1-based; blank lines count, so a one-line-per-term text numbers records like lines. */
  record: number;
  fields: string[];
}

/**
 * Splits text into records per RFC 4180: a field in double quotes may hold
 * the separator and line breaks, `""` is a quote, and records end at CRLF, LF
 * or CR. An opening quote with no closing one is an error naming its record.
 */
function parseRecords(
  text: string,
  separator: string,
): { records: CsvRecord[]; unterminated?: number } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let record = 1;
  let start = 1;
  const endField = () => {
    fields.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (fields.some((f) => f !== '')) records.push({ record: start, fields });
    fields = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) record++;
        field += c;
      }
    } else if (c === '"' && field.trim() === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (c === separator) {
      endField();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      record++;
      start = record;
    } else if (!wasQuoted) {
      field += c;
    } else if (c.trim()) {
      // Text after a closing quote: keep it, as spreadsheets do.
      field += c;
    }
  }
  if (quoted) return { records, unterminated: start };
  endRecord();
  return { records };
}

const HEADER = /^(term|keyterm|keyterms|nøgleord)$/i;

/**
 * Parses keyterms: `term` or `term,boost` per record. Blank records are
 * skipped, a header record is skipped, and a term repeated with other casing
 * keeps its first spelling. Any error imports nothing: `terms` is empty and
 * the first error names its record.
 */
export function parseKeyterms(text: string): { terms: Keyterm[]; errors: KeytermError[] } {
  const body = text.replace(/^\uFEFF/, '');
  const separator = detectSeparator(body);
  const { records, unterminated } = parseRecords(body, separator);
  if (unterminated)
    return { terms: [], errors: [{ code: 'unterminatedQuote', record: unterminated }] };

  const terms: Keyterm[] = [];
  const errors: KeytermError[] = [];
  const seen = new Set<string>();
  records.forEach(({ record, fields }, index) => {
    const [term = '', boostText = '', ...rest] = fields;
    if (index === 0 && HEADER.test(term)) return;
    if (fields.length > 2 && rest.some((f) => f !== '')) {
      errors.push({ code: 'tooManyFields', record });
      return;
    }
    if (!term) return;
    if (term.length > MAX_TERM_LENGTH) {
      errors.push({ code: 'termTooLong', record, max: MAX_TERM_LENGTH });
      return;
    }
    let boost: number | null = null;
    if (boostText) {
      const value = Number(separator === ';' ? boostText.replace(',', '.') : boostText);
      if (!Number.isFinite(value) || value <= 0 || value > MAX_BOOST) {
        errors.push({ code: 'badBoost', record, value: boostText, max: MAX_BOOST });
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
  return errors.length ? { terms: [], errors } : { terms, errors };
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
