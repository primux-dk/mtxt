/*
  The theme's contrast check, the same maths as docs/design/guidelines.html:
  the derived tokens come from tokens.css's color-mix() in oklab, the result
  is clamped to sRGB and rounded to bytes, and the ratio is WCAG 2's relative
  luminance. A pair under 4.5:1 in either theme refuses the value.
  Pure functions, so the server action and the settings preview share them.
*/

type Rgb = [number, number, number];

export const HEX = /^#[0-9a-f]{6}$/i;
export const MIN_RATIO = 4.5;

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

const parse = (hex: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;

const toHex = (rgb: Rgb) =>
  '#' +
  rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

function toOklab(hex: string): Rgb {
  const [r, g, b] = parse(hex).map(decode) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return toHex(
    [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(encode) as Rgb,
  );
}

/** `color-mix(in oklab, a, b <amount>)`: `amount` is b's share, 0 to 1. */
export function mix(a: string, b: string, amount: number): string {
  const x = toOklab(a);
  const y = toOklab(b);
  return fromOklab(x.map((v, i) => v * (1 - amount) + y[i]! * amount) as Rgb);
}

const luminance = (hex: string) => {
  const [r, g, b] = parse(hex).map(decode) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** "4.4:1", rounded down as the guidelines show it, so a refused value never reads 4.5. */
export const formatRatio = (ratio: number) => (Math.floor(ratio * 10) / 10).toFixed(1);

export type ThemeMode = 'light' | 'dark';
export type ContrastPair = 'accentText' | 'primaryText' | 'accentOnCard';

export interface ContrastResult {
  pair: ContrastPair;
  mode: ThemeMode;
  /** Which input the pair depends on, so the error lands at the right field. */
  input: 'accent' | 'primary';
  ratio: number;
  fg: string;
  bg: string;
}

/** The three checked pairs in both themes, per tokens.css. */
export function themeContrast(accent: string, primary: string): ContrastResult[] {
  const a = accent.toLowerCase();
  const p = primary.toLowerCase();
  const pairs: Omit<ContrastResult, 'ratio'>[] = [
    // Light: tokens.css :root
    {
      pair: 'accentText',
      mode: 'light',
      input: 'accent',
      fg: mix(a, '#ffffff', 0.07),
      bg: '#fafafa',
    },
    { pair: 'primaryText', mode: 'light', input: 'primary', fg: '#ffffff', bg: toHex(parse(p)) },
    { pair: 'accentOnCard', mode: 'light', input: 'accent', fg: toHex(parse(a)), bg: '#ffffff' },
    // Dark: tokens.css .dark
    {
      pair: 'accentText',
      mode: 'dark',
      input: 'accent',
      fg: mix(a, '#ffffff', 0.46),
      bg: '#111111',
    },
    {
      pair: 'primaryText',
      mode: 'dark',
      input: 'primary',
      fg: '#111111',
      bg: mix(p, '#ffffff', 0.96),
    },
    {
      pair: 'accentOnCard',
      mode: 'dark',
      input: 'accent',
      fg: mix(a, '#ffffff', 0.33),
      bg: '#1a1a1a',
    },
  ];
  return pairs.map((pair) => ({ ...pair, ratio: contrastRatio(pair.fg, pair.bg) }));
}

/** The failing pairs, worst first. Empty when the two values pass. */
export function themeFailures(accent: string, primary: string): ContrastResult[] {
  return themeContrast(accent, primary)
    .filter((r) => r.ratio < MIN_RATIO)
    .sort((x, y) => x.ratio - y.ratio);
}
