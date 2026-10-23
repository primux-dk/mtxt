import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeMarkdown, parseMarkdown, plainText, toMarkdown } from '../lib/recap/markdown';

const FIXTURE = readFileSync(new URL('./fixtures/recap-every-block.md', import.meta.url), 'utf8');

describe('recap markdown', () => {
  it('round-trips a document with every block', () => {
    const doc = parseMarkdown(FIXTURE);
    const types = new Set<string>();
    doc.descendants((n) => {
      types.add(n.type.name);
      n.marks.forEach((m) => types.add(`mark:${m.type.name}`));
    });
    for (const type of [
      'heading',
      'tableOfContents',
      'callout',
      'decisionList',
      'decisionItem',
      'table',
      'tableRow',
      'tableHeader',
      'tableCell',
      'mention',
      'bulletList',
      'orderedList',
      'listItem',
      'taskList',
      'taskItem',
      'blockquote',
      'horizontalRule',
      'codeBlock',
      'image',
      'details',
      'detailsSummary',
      'detailsContent',
      'hardBreak',
      'mark:bold',
      'mark:italic',
      'mark:strike',
      'mark:code',
      'mark:link',
    ]) {
      expect(types, type).toContain(type);
    }
    expect(toMarkdown(doc)).toBe(FIXTURE);
    expect(parseMarkdown(toMarkdown(doc)).eq(doc)).toBe(true);
  });

  it('reads plain text without markdown syntax', () => {
    const text = plainText(parseMarkdown(FIXTURE));
    expect(text).toContain('Test det nye skift torsdag. @Søren Bak');
    expect(text).not.toContain('mtxt:');
    expect(text).not.toContain('<!--');
  });

  it('lets no other HTML through, and no image from elsewhere', () => {
    expect(normalizeMarkdown('<script>alert(1)</script>\n')).toBe('<script>alert(1)</script>\n');
    expect(parseMarkdown('<script>alert(1)</script>\n').firstChild?.type.name).toBe('paragraph');
    expect(normalizeMarkdown('Se <b>dette</b>.\n')).toBe('Se <b>dette</b>.\n');
    expect(parseMarkdown('Se <b>dette</b>.\n').firstChild?.textContent).toBe('Se <b>dette</b>.');
    expect(normalizeMarkdown('![sporing](https://example.com/pixel.png)\n')).toBe('sporing\n');
    // Not a link: markdown-it refuses the address, and the text stays text.
    const marks: string[] = [];
    parseMarkdown('[klik](javascript:alert(1))\n').descendants((n) => {
      n.marks.forEach((m) => marks.push(m.type.name));
    });
    expect(marks).toEqual([]);
  });

  it('reads the forms a model or a person may write', () => {
    // A one-line toggle, the other alert kinds, a mention of nobody, a decisions marker with no list.
    expect(normalizeMarkdown('<details><summary>Mere</summary>Tekst her.</details>\n')).toBe(
      '<details>\n<summary>Mere</summary>\n\nTekst her.\n\n</details>\n',
    );
    expect(normalizeMarkdown('> [!TIP]\n> Et tip.\n')).toBe('> [!NOTE]\n> Et tip.\n');
    expect(normalizeMarkdown('> [!CAUTION]\n> Pas på.\n')).toBe('> [!WARNING]\n> Pas på.\n');
    const nodes: string[] = [];
    parseMarkdown('[@Nogen](mtxt:user/bad id)\n').descendants((n) => {
      nodes.push(n.type.name);
    });
    expect(nodes).not.toContain('mention');
    expect(normalizeMarkdown('<!-- decisions -->\n\nIngen liste.\n')).toBe('Ingen liste.\n');
    expect(normalizeMarkdown('')).toBe('');
  });
});
