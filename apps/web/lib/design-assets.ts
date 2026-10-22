import 'server-only';
// docs/design is the one source of the look. These files are bundled into the
// Worker at build time and served under /design, so the reference pages and the
// install cannot drift apart.
import guidelines from '../../../docs/design/guidelines.html?raw';
import mockups from '../../../docs/design/mockups/index.html?raw';
import tokens from '../../../docs/design/tokens.css?raw';
import readme from '../../../docs/design/README.md?raw';
import behaviour from '../../../docs/design/behaviour.md?raw';
import localeEn from '../../../docs/design/locales/en.json?raw';
import localeDa from '../../../docs/design/locales/da.json?raw';
import fontLicence from '../../../docs/design/fonts/LICENSE-mona-sans.txt?raw';
import font from '../../../docs/design/fonts/mona-sans.woff2?base64';
import { type Asset, lookupAsset } from './asset-map';

const text = (type: string, body: string): Asset => ({ type: `${type}; charset=utf-8`, body });

/** Paths relative to docs/design, as the pages link to them. */
const ASSETS: ReadonlyMap<string, Asset> = new Map([
  ['mockups/index.html', text('text/html', mockups)],
  ['tokens.css', text('text/css', tokens)],
  ['README.md', text('text/markdown', readme)],
  ['behaviour.md', text('text/markdown', behaviour)],
  ['locales/en.json', text('application/json', localeEn)],
  ['locales/da.json', text('application/json', localeDa)],
  ['fonts/LICENSE-mona-sans.txt', text('text/plain', fontLicence)],
  ['fonts/mona-sans.woff2', { type: 'font/woff2', base64: font }],
]);

export const designAsset = (path: string) => lookupAsset(ASSETS, path);

/**
 * guidelines.html with the install's two theme values set on :root, placed
 * before the page's script so the theme panel starts from them. Callers pass
 * values already checked to be #rrggbb.
 */
export function guidelinesPage(theme: { accent: string; primary: string }): string {
  const style = `<style>:root{--theme-accent:${theme.accent};--theme-primary:${theme.primary}}</style>\n`;
  const at = guidelines.lastIndexOf('<script>');
  return at === -1 ? guidelines + style : guidelines.slice(0, at) + style + guidelines.slice(at);
}
