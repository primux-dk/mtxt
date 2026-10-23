import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
// @ts-expect-error a plain .mjs script without types
import { render, target } from '../scripts/infoplist-strings.mjs';

describe('macOS permission texts', () => {
  for (const lang of ['en', 'da']) {
    it(`InfoPlist.strings for ${lang} is current`, () => {
      expect(readFileSync(target(lang), 'utf8')).toBe(render(lang));
    });
  }

  it('Info.plist carries the English source', () => {
    const plist = readFileSync(new URL('../src-tauri/Info.plist', import.meta.url), 'utf8');
    expect(plist).toContain(en['macos.microphoneUsage']);
    expect(plist).toContain(en['macos.audioCaptureUsage']);
  });
});
