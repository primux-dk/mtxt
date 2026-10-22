/** Shared formatting for durations and positions. Words come from the locale files. */
type T = (key: 'durationMinutes' | 'durationHours', values: Record<string, number>) => string;

export function formatDuration(t: T, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t('durationMinutes', { minutes });
  return t('durationHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** 01:03, or 1:02:03 past an hour. Numerals only, so no locale strings. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
