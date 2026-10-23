// The install's two theme colours, turned into the derived tokens the same
// way docs/design/tokens.css does it with color-mix() in oklab. The web
// library lets the browser do the mixing; the recorder computes it here, so
// the values do not depend on the WebView's CSS support and can be tested
// against the defaults written in tokens.css.

type Rgb = [number, number, number];
type Lab = [number, number, number];

function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

// Björn Ottosson's sRGB <-> Oklab matrices, as CSS Color 4 uses them.
export function rgbToOklab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => fromLinear(Math.min(1, Math.max(0, v)))) as Rgb;
}

/** color-mix(in oklab, a, b p%): `p` is the share of `b`, 0 to 100. */
export function mix(a: string, b: string, p: number): string {
  const la = rgbToOklab(parseHex(a));
  const lb = rgbToOklab(parseHex(b));
  const t = p / 100;
  return toHex(oklabToRgb([0, 1, 2].map((i) => la[i]! * (1 - t) + lb[i]! * t) as Lab));
}

const WHITE = '#ffffff';
const INK = '#111111';
const GREY = '#888888';

/** Every token tokens.css derives from the two inputs, for one theme. */
export function deriveTokens(accent: string, primary: string, dark: boolean): Record<string, string> {
  const t: Record<string, string> = dark
    ? {
        '--primary': mix(primary, WHITE, 96),
        '--primary-hover': mix(primary, WHITE, 88),
        '--accent-strong': mix(accent, WHITE, 33),
        '--accent-secondary': mix(accent, WHITE, 46),
        '--accent-text': mix(accent, WHITE, 46),
        '--accent-light': mix(accent, WHITE, 61),
        '--accent-tint': mix(accent, INK, 71),
        '--accent-tint-soft': mix(accent, INK, 79),
        '--accent-tint-strong': mix(accent, INK, 58),
        '--accent-line': mix(accent, INK, 49),
        '--accent-line-strong': mix(accent, INK, 31),
        '--accent-line-control': mix(accent, accent, 0),
        '--accent-deep': mix(accent, WHITE, 82),
      }
    : {
        '--primary': mix(primary, primary, 0),
        '--primary-hover': mix(primary, WHITE, 17),
        '--accent-strong': mix(accent, accent, 0),
        '--accent-secondary': mix(accent, GREY, 13),
        '--accent-text': mix(accent, WHITE, 7),
        '--accent-light': mix(accent, WHITE, 33),
        '--accent-tint': mix(accent, WHITE, 94),
        '--accent-tint-soft': mix(accent, WHITE, 95),
        '--accent-tint-strong': mix(accent, WHITE, 91),
        '--accent-line': mix(accent, WHITE, 87),
        '--accent-line-strong': mix(accent, WHITE, 84),
        '--accent-line-control': mix(accent, WHITE, 81),
        '--accent-deep': mix(accent, INK, 67),
      };
  t['--accent'] = t['--accent-tint']!;
  t['--accent-foreground'] = t['--accent-strong']!;
  t['--ring'] = t['--accent-strong']!;
  t['--chart-1'] = t['--accent-strong']!;
  t['--chart-2'] = t['--accent-light']!;
  return t;
}

export const DEFAULT_ACCENT = '#566b45';
export const DEFAULT_PRIMARY = '#111111';

/** Set the derived tokens on <html> for the current colour scheme. */
export function applyTheme(accent = DEFAULT_ACCENT, primary = DEFAULT_PRIMARY): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.setProperty('--theme-accent', accent);
  root.style.setProperty('--theme-primary', primary);
  let safeAccent = accent;
  let safePrimary = primary;
  try {
    parseHex(accent);
    parseHex(primary);
  } catch {
    safeAccent = DEFAULT_ACCENT;
    safePrimary = DEFAULT_PRIMARY;
  }
  for (const [k, v] of Object.entries(deriveTokens(safeAccent, safePrimary, dark))) {
    root.style.setProperty(k, v);
  }
}
