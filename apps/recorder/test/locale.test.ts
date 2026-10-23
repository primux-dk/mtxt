import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import da from '../locales/da.json';
import enWindows from '../locales/en.windows.json';
import daWindows from '../locales/da.windows.json';
import designEn from '../../../docs/design/locales/en.json';
import designDa from '../../../docs/design/locales/da.json';
import { format, setLanguage, t } from '../src/locale';
import { clock, duration, initials } from '../src/format';

describe('locale files', () => {
  it('have the same keys in both languages', () => {
    expect(Object.keys(da).sort()).toEqual(Object.keys(en).sort());
  });

  it('carry the design system recorder and live strings unchanged', () => {
    for (const [k, v] of Object.entries(designEn as Record<string, string>)) {
      if (!k.startsWith('recorder.') && !k.startsWith('live.')) continue;
      expect((en as Record<string, string>)[k], k).toBe(v);
      expect((da as Record<string, string>)[k], k).toBe((designDa as Record<string, string>)[k]);
    }
  });

  it('format arguments and plurals', () => {
    expect(format('Uploading {done}/{total}', { done: 2, total: 5 })).toBe('Uploading 2/5');
    expect(format(en['recorder.queue.count'], { count: 1 })).toBe('1 file');
    expect(format(en['recorder.queue.count'], { count: 4 })).toBe('4 files');
    expect(format('{missing}', {})).toBe('{missing}');
  });

  it('no message contains an em dash', () => {
    for (const v of [...Object.values(en), ...Object.values(da)]) expect(v).not.toContain('—');
    for (const v of [...Object.values(enWindows), ...Object.values(daWindows)])
      expect(v).not.toContain('—');
  });
});

describe('Windows wording', () => {
  const pairs = [
    ['en', en, enWindows, 'this Mac', 'this PC'],
    ['da', da, daWindows, 'denne Mac', 'denne pc'],
  ] as const;

  // States Windows never reaches: it asks nothing first (no intro) and
  // loopback is always allowed (no denied or unsupported system audio).
  const macOnly = new Set([
    'recorder.permission.intro',
    'recorder.permission.system.denied',
    'recorder.permission.system.unsupported',
  ]);

  it('has the same keys in both languages, each one in the base file', () => {
    expect(Object.keys(daWindows).sort()).toEqual(Object.keys(enWindows).sort());
    for (const k of Object.keys(enWindows)) expect(en, k).toHaveProperty([k]);
  });

  for (const [lang, base, win, mac, pc] of pairs) {
    it(`${lang}: every message that names the Mac has Windows wording, and it is current`, () => {
      const b = base as Record<string, string>;
      const w = win as Record<string, string>;
      for (const [k, v] of Object.entries(b)) {
        if (k.startsWith('macos.')) continue;
        if (/\bMac\b|macOS|System Settings|Systemindstillinger/.test(v)) {
          if (!macOnly.has(k)) expect(w, k).toHaveProperty([k]);
        }
        // A message that only swaps the computer's name follows its base text.
        if (v.includes(mac) && k in w) expect(w[k], k).toBe(v.replaceAll(mac, pc));
      }
      for (const v of Object.values(w)) expect(v).not.toMatch(/\bMac\b|macOS|System Settings/);
    });
  }

  it('is what the window shows on Windows, and only there', () => {
    setLanguage('da', 'windows');
    expect(t('recorder.menu.delete')).toBe('Slet fra denne pc');
    expect(t('menu.stop')).toBe('Stop optagelse');
    setLanguage('da', 'macos');
    expect(t('recorder.menu.delete')).toBe('Slet fra denne Mac');
    setLanguage('en');
    expect(t('recorder.permission.openSettings')).toBe('Open System Settings');
  });
});

describe('format', () => {
  it('clock, duration and initials', () => {
    expect(clock(1122)).toBe('00:18:42');
    expect(clock(4 * 3600)).toBe('04:00:00');
    expect(duration(2526)).toBe('42:06');
    expect(duration(14_400)).toBe('4:00:00');
    expect(initials('Mette Lund')).toBe('ML');
    expect(initials('Søren')).toBe('S');
    expect(initials('  ')).toBe('?');
  });
});
