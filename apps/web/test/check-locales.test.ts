import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLocales } from '../scripts/check-locales.mjs';

/** A throwaway apps/web with the given messages and source files. */
function fixture(messages: { en: object; da: object }, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'mtxt-locales-'));
  mkdirSync(join(root, 'messages'));
  writeFileSync(join(root, 'messages/en.json'), JSON.stringify(messages.en, null, 2));
  writeFileSync(join(root, 'messages/da.json'), JSON.stringify(messages.da, null, 2));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

describe('check-locales', () => {
  it('passes on the app as it is', () => {
    expect(checkLocales()).toEqual({ missing: [], unused: [], emDashes: [] });
  });

  it('finds a key one language lacks, an unused key and an em dash', () => {
    const root = fixture(
      {
        en: { nav: { home: 'Home', gone: 'Gone' }, extra: 'Only English' },
        da: { nav: { home: 'Hjem — her', gone: 'Væk' } },
      },
      {
        'components/nav.tsx':
          "const t = useTranslations('nav');\nexport const a = t('home');\nconst e = useTranslations();\ne('extra');",
      },
    );
    const result = checkLocales(root);
    expect(result.missing).toEqual([{ lang: 'da', key: 'extra' }]);
    expect(result.unused).toEqual(['nav.gone']);
    expect(result.emDashes).toEqual([{ lang: 'da', line: 3, text: '"home": "Hjem — her",' }]);
  });

  it('reads templates, strings inside templates and helpers handed a t', () => {
    const messages = {
      error: { a: { title: 'A' }, b: { title: 'B' } },
      audit: { details: { removed: 'R' }, other: 'O' },
      format: { minutes: '{m} min' },
      live: { label: 'Live' },
      field: { name: { label: 'Name' } },
    };
    const root = fixture(
      { en: messages, da: messages },
      {
        'app/page.tsx':
          "import { duration } from '@/lib/format';\nconst t = getTranslations('error');\nt(`${code}.title`);\nconst f = getTranslations('format');\nduration(f);",
        'components/audit.tsx':
          "const t = await getTranslations('audit');\nconst s = `${x} · ${t('details.removed')}`;",
        'components/field.tsx': "const t = useTranslations('field');\nt(`${kind}.label`);",
        'lib/format.ts': "export const duration = (t) => t('minutes');",
      },
    );
    // `${kind}.label` under `field` reaches field.name.label, not live.label.
    expect(checkLocales(root).unused).toEqual(['audit.other', 'live.label']);
  });
});
