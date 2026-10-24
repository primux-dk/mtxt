// The recorder's strings, from apps/recorder/locales. English is the source;
// Danish the first translation. `<lang>.windows.json` holds the Windows
// wording of the messages that name the Mac or its settings ("this PC",
// "Settings → Privacy & security"); on Windows it is read before the base file. Messages are ICU: `{name}` arguments and
// `{count, plural, one {...} other {...}}`. The window marks text with
// `data-i18n="key"` and attributes with `data-i18n-attr="aria-label:key"`.

import en from '../locales/en.json';
import da from '../locales/da.json';
import enWindows from '../locales/en.windows.json';
import daWindows from '../locales/da.windows.json';

export type Lang = 'en' | 'da';
export type Platform = 'macos' | 'windows';
export type Args = Record<string, string | number>;

const files: Record<Lang, Record<string, string>> = { en, da };
const overrides: Record<Platform, Record<Lang, Record<string, string>>> = {
  macos: { en: {}, da: {} },
  windows: { en: enWindows, da: daWindows },
};
let lang: Lang = 'en';
let platform: Platform = 'macos';

export function setLanguage(next: string, os?: string): void {
  lang = next === 'da' ? 'da' : 'en';
  platform = os === 'windows' ? 'windows' : 'macos';
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export function language(): Lang {
  return lang;
}

/** en-GB or da-DK, for dates, numbers and durations. */
export function intlLocale(): string {
  return lang === 'da' ? 'da-DK' : 'en-GB';
}

export function t(key: string, args: Args = {}): string {
  const own = overrides[platform];
  const msg = own[lang][key] ?? files[lang][key] ?? own.en[key] ?? files.en[key] ?? key;
  return format(msg, args);
}

export function format(msg: string, args: Args): string {
  let out = '';
  let i = 0;
  while (i < msg.length) {
    const ch = msg[i]!;
    if (ch !== '{') {
      out += ch;
      i++;
      continue;
    }
    const end = matching(msg, i);
    const inner = msg.slice(i + 1, end);
    i = end + 1;
    const parts = inner.split(',');
    const name = parts[0]!.trim();
    if (parts.length >= 3 && parts[1]!.trim() === 'plural') {
      const forms = parts.slice(2).join(',');
      const n = Number(args[name] ?? 0);
      const body =
        form(forms, `=${n}`) ??
        form(forms, n === 1 ? 'one' : 'other') ??
        form(forms, 'other') ??
        '';
      out += format(body.replaceAll('#', new Intl.NumberFormat(intlLocale()).format(n)), args);
    } else {
      out += name in args ? String(args[name]) : `{${name}}`;
    }
  }
  return out;
}

function matching(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    if (s[j] === '}' && --depth === 0) return j;
  }
  return s.length;
}

function form(forms: string, selector: string): string | undefined {
  let i = 0;
  while (i < forms.length) {
    while (forms[i] === ' ') i++;
    const start = i;
    while (i < forms.length && forms[i] !== '{' && forms[i] !== ' ') i++;
    const sel = forms.slice(start, i);
    while (i < forms.length && forms[i] !== '{') i++;
    if (i >= forms.length) return undefined;
    const end = matching(forms, i);
    const body = forms.slice(i + 1, end);
    i = end + 1;
    if (sel === selector) return body;
  }
  return undefined;
}

/** Fill every `data-i18n` and `data-i18n-attr` under `root`. */
export function translate(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr!.split(',')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  });
}
