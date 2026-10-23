import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveTokens, mix } from '../src/theme';

// The defaults written next to each derivation in docs/design/tokens.css.
function documented(dark: boolean): Record<string, string> {
  const css = readFileSync(new URL('../../../docs/design/tokens.css', import.meta.url), 'utf8');
  const marker = dark ? 'Derived from the two theme inputs, dark.' : 'Derived from the two theme inputs, light.';
  const block = css.slice(css.indexOf(marker), css.indexOf('}', css.indexOf('{', css.indexOf(marker))));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z-]+):[^;]+;\s*\/\* (#[0-9a-f]{6}) \*\//g)) out[m[1]!] = m[2]!;
  return out;
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('theme derivation', () => {
  for (const dark of [false, true]) {
    it(`matches tokens.css for the default inputs, ${dark ? 'dark' : 'light'}`, () => {
      const want = documented(dark);
      expect(Object.keys(want).length).toBeGreaterThan(10);
      const got = deriveTokens('#566b45', '#111111', dark);
      for (const [k, v] of Object.entries(want)) {
        const diff = channels(got[k]!).map((c, i) => Math.abs(c - channels(v)[i]!));
        expect(Math.max(...diff), `${k}: ${got[k]} vs ${v}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('mixes like color-mix in oklab', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 100)).toBe('#ffffff');
    expect(mix('#4a6382', '#ffffff', 94)).toMatch(/^#f[0-9a-f]{5}$/);
  });
});
