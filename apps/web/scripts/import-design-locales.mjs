// One-off: converts docs/design/locales/*.json (flat dotted keys, the mockups'
// copy) into nested JSON under apps/web/messages for next-intl.
//
// Since packet 1 the files in apps/web/messages are the source for the app.
// Run this again only to re-seed them from the mockups on purpose; it
// overwrites apps/web/messages/en.json and da.json.
//
// next-intl reads dots as nesting, so a key that is both a string and a prefix
// ("meeting.keep" and "meeting.keep.label") cannot stay as it is. The string
// moves to "<key>.text" ("meeting.keep.text"), and the script lists each move.
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../../../docs/design/locales/', import.meta.url);
const target = new URL('../messages/', import.meta.url);

export function nest(flat) {
  const keys = Object.keys(flat);
  const prefixes = new Set(
    keys.flatMap((key) => {
      const parts = key.split('.');
      return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.'));
    }),
  );
  const moved = [];
  const out = {};
  for (const key of keys) {
    const path = prefixes.has(key) ? `${key}.text` : key;
    if (path !== key) moved.push(`${key} -> ${path}`);
    const parts = path.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = flat[key];
  }
  return { nested: out, moved };
}

for (const locale of ['en', 'da']) {
  const flat = JSON.parse(await readFile(new URL(`${locale}.json`, source), 'utf8'));
  const { nested, moved } = nest(flat);
  await writeFile(new URL(`${locale}.json`, target), JSON.stringify(nested, null, 2) + '\n');
  console.log(
    `${locale}: ${Object.keys(flat).length} keys${moved.length ? `; moved ${moved.join(', ')}` : ''}`,
  );
}
