/*
  Export (docs/spec.md, "Recap editor"): the file name and the headers for a
  download. The markdown is the stored body; the Word file is built from the
  same document (lib/recap/docx.ts).
*/
export const EXPORT_FORMATS = ['md', 'docx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * "Produktionsmøde, uge 43 2026-10-22.docx": the title made safe for a file
 * system, and the meeting's date. `json` is a webhook's transcript link.
 */
export function exportFileName(
  title: string,
  startedAt: Date,
  format: ExportFormat | 'json',
): string {
  const safe = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return `${safe || 'Recap'} ${startedAt.toISOString().slice(0, 10)}.${format}`;
}

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function attachment(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
