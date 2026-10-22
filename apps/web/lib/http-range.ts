/**
 * Reads a single-range `Range: bytes=…` header against an object of `size`
 * bytes. Null means serve the whole object (no header, or one we do not
 * handle, such as several ranges); 'unsatisfiable' means answer 416.
 */
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = '', endText = ''] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    // bytes=-500: the last 500 bytes.
    const suffix = Number(endText);
    if (suffix === 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(startText);
  if (start >= size) return 'unsatisfiable';
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}
