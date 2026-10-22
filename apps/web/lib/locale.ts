export const LOCALES = ['en', 'da'] as const;
export type Locale = (typeof LOCALES)[number];

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/**
 * The interface language for a request (docs/spec.md): the browser's language
 * when a translation exists, otherwise the install's default.
 */
export function resolveLocale(acceptLanguage: string | null, installDefault: Locale): Locale {
  if (!acceptLanguage) return installDefault;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter(({ tag, q }) => tag && tag !== '*' && q > 0 && !Number.isNaN(q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const base = tag.split('-')[0] ?? '';
    if (isLocale(base)) return base;
  }
  return installDefault;
}
