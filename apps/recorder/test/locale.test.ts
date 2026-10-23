import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import da from '../locales/da.json';
import designEn from '../../../docs/design/locales/en.json';
import designDa from '../../../docs/design/locales/da.json';
import { format } from '../src/locale';
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
