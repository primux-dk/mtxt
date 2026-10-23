import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setLanguage, translate } from '../src/locale';

// The real translator over the real host input, with a minimal stand-in for
// the DOM: the input's attributes as written in index.html.
function hostInput() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const tag = /<input[^>]*id="host"[^>]*>/s.exec(html)![0];
  const attrs = Object.fromEntries([...tag.matchAll(/([a-z0-9-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  const el = {
    attrs: { ...attrs } as Record<string, string>,
    dataset: { i18nAttr: attrs['data-i18n-attr'] } as Record<string, string | undefined>,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
  };
  const root = {
    querySelectorAll: (sel: string) => (sel === '[data-i18n-attr]' && el.dataset.i18nAttr ? [el] : []),
  };
  return { el, root: root as unknown as ParentNode };
}

describe('host field placeholder', () => {
  for (const [lang, want] of [
    ['da', 'moeder.dinvirksomhed.dk'],
    ['en', 'meetings.yourcompany.com'],
  ] as const) {
    it(`is ${want} in ${lang}`, () => {
      (globalThis as { document?: unknown }).document = { documentElement: {} };
      setLanguage(lang);
      const { el, root } = hostInput();
      translate(root);
      expect(el.attrs.placeholder).toBe(want);
    });
  }
});
