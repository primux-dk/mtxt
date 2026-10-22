import { describe, expect, it } from 'vitest';
import en from '../messages/en.json';
import da from '../messages/da.json';
import { resolveLocale } from '../lib/locale';

describe('resolveLocale', () => {
  it('takes the browser language when a translation exists', () => {
    expect(resolveLocale('da-DK,da;q=0.9,en;q=0.8', 'en')).toBe('da');
    expect(resolveLocale('en-GB,en;q=0.9', 'da')).toBe('en');
  });

  it('respects q values over order', () => {
    expect(resolveLocale('en;q=0.5,da;q=0.9', 'en')).toBe('da');
  });

  it('falls back to the install default', () => {
    expect(resolveLocale('de-DE,fr;q=0.8', 'da')).toBe('da');
    expect(resolveLocale(null, 'en')).toBe('en');
    expect(resolveLocale('*', 'da')).toBe('da');
  });
});

describe('messages', () => {
  const keys = (node: object, prefix = ''): string[] =>
    Object.entries(node).flatMap(([k, v]) =>
      typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );

  it('has the same keys in every locale', () => {
    expect(keys(da).sort()).toEqual(keys(en).sort());
  });
});
