import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  formatRatio,
  mix,
  themeContrast,
  themeFailures,
} from '../lib/theme/contrast';

describe('mix (color-mix in oklab)', () => {
  // The values tokens.css's comments give for the default theme inputs.
  it.each([
    ['#566b45', '#ffffff', 0.07, '#617551'],
    ['#566b45', '#ffffff', 0.33, '#8a9a7f'],
    ['#566b45', '#ffffff', 0.46, '#a0ad97'],
    ['#566b45', '#ffffff', 0.94, '#f4f6f3'],
    ['#566b45', '#888888', 0.13, '#5c6f4e'],
    ['#566b45', '#111111', 0.67, '#262c21'],
    ['#566b45', '#111111', 0.71, '#23291f'],
    ['#111111', '#ffffff', 0.17, '#323232'],
    ['#111111', '#ffffff', 0.96, '#f4f4f4'],
  ])('mix(%s, %s, %s) is %s', (a, b, amount, expected) => {
    expect(mix(a, b, amount)).toBe(expected);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#566b45', '#566b45')).toBe(1);
  });

  it('rounds down for display, so 4.49 never reads as 4.5', () => {
    expect(formatRatio(4.49)).toBe('4.4');
    expect(formatRatio(12)).toBe('12.0');
  });
});

describe('themeContrast', () => {
  it('passes the default theme in both modes', () => {
    expect(themeContrast('#566b45', '#111111')).toHaveLength(6);
    expect(themeFailures('#566b45', '#111111')).toEqual([]);
  });

  it('passes the muted blue from figure 11', () => {
    expect(themeFailures('#4a6382', '#111111')).toEqual([]);
  });

  it('refuses a light accent on the light background, worst pair first', () => {
    const failures = themeFailures('#a3c47d', '#111111');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatchObject({ pair: 'accentText', mode: 'light', input: 'accent' });
    expect(failures[0]!.ratio).toBeLessThan(4.5);
    for (let i = 1; i < failures.length; i++) {
      expect(failures[i]!.ratio).toBeGreaterThanOrEqual(failures[i - 1]!.ratio);
    }
  });

  it('refuses a dark accent in dark mode', () => {
    const failures = themeFailures('#1a2410', '#111111');
    expect(failures.some((f) => f.mode === 'dark' && f.input === 'accent')).toBe(true);
  });

  it('refuses a button colour that white text cannot sit on', () => {
    const failures = themeFailures('#566b45', '#ffd400');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ pair: 'primaryText', mode: 'light', input: 'primary' });
  });
});
