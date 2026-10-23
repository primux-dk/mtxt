#!/usr/bin/env node
/*
  Locale hygiene for apps/web/messages (packet 10). Fails on:

  - a key that one language has and the other lacks;
  - a key the app never uses;
  - an em dash anywhere in either file (docs/design/README.md, writing rules).

  "Used" is read from the source, file by file. A file's namespaces are the
  string arguments of its useTranslations and getTranslations calls; a call
  with no argument is the root. A key is used when a string in the same file
  names it under one of those namespaces, or when any file names it in full.
  A file that asks for no namespace (a helper handed a `t`, such as
  components/meetings/format.ts) reads under the namespaces of the files
  that import it. A template string such as `error.${code}` stands for every
  key it can make; one that starts with `${` counts only under a namespace.
  The check is a reading of the source, not a proof: a key reached only
  through a variable (`t(visibility)`) passes because the values appear as
  strings next to it.

  Usage: node scripts/check-locales.mjs (from apps/web). Exits 1 on a problem.
*/
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGUAGES = ['en', 'da'];
const SOURCES = ['app', 'components', 'lib', 'i18n', 'middleware.ts', 'worker.ts', 'workers'];
const EM_DASH = '—';

/** Every leaf of a messages object, as dotted paths. */
function leaves(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' ? leaves(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

function sourceFiles(path) {
  if (!statSync(path, { throwIfNoEntry: false })) return [];
  if (statSync(path).isFile()) return /\.(ts|tsx|mjs|js)$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((name) =>
    name === 'node_modules' || name.startsWith('.') ? [] : sourceFiles(join(path, name)),
  );
}

/** The quoted strings of a source file: plain ones as text, template ones as patterns. */
function strings(source) {
  const plain = [];
  const templates = [];
  const pattern =
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) plain.push(match[1]);
    else if (match[2] !== undefined) plain.push(match[2]);
    else if (match[3] !== undefined) {
      // Strings inside a template's ${...} count too: `${a} · ${t('b.c')}`.
      for (const inner of match[3].matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
        const nested = strings(inner[1]);
        plain.push(...nested.plain);
        templates.push(...nested.templates);
      }
      if (!match[3].includes('${')) plain.push(match[3]);
      else if (
        /^[\w.]*(\$\{(?:[^{}]|\{[^{}]*\})*\}[\w.]*)+$/.test(match[3]) &&
        /[A-Za-z]/.test(match[3].replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ''))
      ) {
        // `a.${x}.b` matches a.<anything>.b; nested templates are rare enough to read loosely.
        const parts = match[3].split(/\$\{(?:[^{}]|\{[^{}]*\})*\}/);
        const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp(`^${escaped.join('.+')}$`);
        // `${x}.label` can be any namespace's label: only one that starts with text names a whole key.
        regex.anchored = parts[0] !== '';
        templates.push(regex);
      }
    }
  }
  return { plain, templates };
}

/** The namespaces a file asks for; '' stands for the root. */
function namespaces(source) {
  const found = new Set();
  const call =
    /\b(?:useTranslations|getTranslations)\(\s*(?:'([^']*)'|"([^"]*)"|\{[^}]*namespace:\s*'([^']*)'[^}]*\}|\))/g;
  for (const match of source.matchAll(call)) found.add(match[1] ?? match[2] ?? match[3] ?? '');
  return [...found];
}

/** The source files a file imports, by `@/` or a relative path. */
function imports(root, file, source) {
  const found = [];
  for (const match of source.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)) {
    const spec = match[1] ?? match[2];
    const base = spec.startsWith('@/')
      ? join(root, spec.slice(2))
      : spec.startsWith('.')
        ? join(dirname(file), spec)
        : null;
    if (!base) continue;
    const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].find((ext) =>
      statSync(base + ext, { throwIfNoEntry: false })?.isFile(),
    );
    if (hit !== undefined) found.push(base + hit);
  }
  return found;
}

export function checkLocales(root = ROOT) {
  const raw = Object.fromEntries(
    LANGUAGES.map((lang) => [lang, readFileSync(join(root, 'messages', `${lang}.json`), 'utf8')]),
  );
  const keys = Object.fromEntries(
    LANGUAGES.map((lang) => [lang, new Set(leaves(JSON.parse(raw[lang])))]),
  );

  const missing = LANGUAGES.flatMap((lang) =>
    LANGUAGES.filter((other) => other !== lang).flatMap((other) =>
      [...keys[other]].filter((k) => !keys[lang].has(k)).map((key) => ({ lang, key })),
    ),
  );

  const emDashes = LANGUAGES.flatMap((lang) =>
    raw[lang]
      .split('\n')
      .map((line, i) => ({ lang, line: i + 1, text: line.trim() }))
      .filter((l) => l.text.includes(EM_DASH)),
  );

  const files = SOURCES.flatMap((s) => sourceFiles(join(root, s)));
  const all = new Set([...keys.en, ...keys.da]);
  const used = new Set();
  const global = { plain: new Set(), templates: [] };
  const importers = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const spaces = namespaces(source).filter(Boolean);
    for (const target of imports(root, file, source)) {
      if (!importers.has(target)) importers.set(target, new Set());
      spaces.forEach((ns) => importers.get(target).add(ns));
    }
  }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const { plain, templates } = strings(source);
    plain.forEach((s) => global.plain.add(s));
    global.templates.push(...templates);
    // A file that asks for no namespace is a helper handed a `t` (components/meetings/format.ts):
    // its strings count under the namespaces of the files that import it.
    const own = namespaces(source);
    const spaces = own.length ? own : [...(importers.get(file) ?? [])];
    for (const key of all) {
      for (const ns of spaces) {
        if (ns && !key.startsWith(`${ns}.`)) continue;
        const rest = ns ? key.slice(ns.length + 1) : key;
        if (plain.includes(rest) || templates.some((t) => (ns || t.anchored) && t.test(rest))) {
          used.add(key);
          break;
        }
      }
    }
  }
  // Named in full anywhere: a key handed from one file to the `t` of another.
  for (const key of all) {
    if (used.has(key)) continue;
    if (global.plain.has(key) || global.templates.some((t) => t.anchored && t.test(key)))
      used.add(key);
  }
  const unused = [...all].filter((k) => !used.has(k)).sort();

  return { missing, unused, emDashes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { missing, unused, emDashes } = checkLocales();
  for (const m of missing) console.error(`messages/${m.lang}.json lacks ${m.key}`);
  for (const k of unused) console.error(`unused in the app: ${k}`);
  for (const d of emDashes)
    console.error(`em dash in messages/${d.lang}.json:${d.line}: ${d.text}`);
  const problems = missing.length + unused.length + emDashes.length;
  if (problems) {
    console.error(`${problems} locale problem${problems === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log('Locales: every key in both languages, every key used, no em dash.');
}
