/**
 * Reads a `Range` header against an object of `size` bytes. Null means no
 * header: serve the whole object. A header that is malformed, asks for
 * several ranges, or lies past the end is 'unsatisfiable': answer 416 with
 * Content-Range "bytes (asterisk)/size". Only one `bytes=` range is served.
 */
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'unsatisfiable';
  const [, startText = '', endText = ''] = match;
  if (!startText && !endText) return 'unsatisfiable';
  if (startText.length > 15 || endText.length > 15) return 'unsatisfiable';
  if (!startText) {
    // bytes=-500: the last 500 bytes.
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startText);
  if (start >= size) return 'unsatisfiable';
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

/**
 * A `Range:` header with an empty value, if the runtime passes one, is a
 * malformed range: give it a value parseRange refuses, so the route answers
 * 416 even if a hop between here and the route drops empty headers. Local
 * workerd (wrangler 4.151) already strips an empty header before the Worker
 * runs, so there the request arrives with no Range at all.
 */
export function keepEmptyRange(request: Request): Request {
  if (!request.headers.has('range') || request.headers.get('range')?.trim()) return request;
  const headers = new Headers(request.headers);
  headers.set('range', 'empty');
  return new Request(request, { headers });
}
