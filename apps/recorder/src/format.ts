// Dates, durations and sizes in the interface language.

import { intlLocale } from './locale';

/** 00:18:42, the recorder clock. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** 42:06, or 4:00:00 from an hour. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** "23 Oct 2026, 09:00" or "23. okt. 2026 09.00". */
export function dateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** 670 MB, 1.6 GB, in the locale's decimal style. */
export function size(bytes: number): string {
  const mb = bytes / 1_000_000;
  const nf = (v: number, digits: number) =>
    new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits }).format(v);
  if (mb >= 1000) return `${nf(mb / 1000, 1)} GB`;
  if (mb >= 10) return `${nf(mb, 0)} MB`;
  return `${nf(mb, 1)} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts.slice(0, 1);
  return letters.map((p) => [...p][0]!.toUpperCase()).join('') || '?';
}
