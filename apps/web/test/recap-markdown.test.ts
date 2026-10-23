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
    const dues: unknown[] = [];
    doc.descendants((n) => {
      if (n.type.name === 'decisionItem') dues.push(n.attrs.due);
      return true;
    });
    expect(dues).toEqual(['2026-10-29', null]);
  });

  it("keeps a decision's due date as `~YYYY-MM-DD` at the end of its first line", () => {
    const due = (md: string) => {
      const out: unknown[] = [];
      parseMarkdown(md).descendants((n) => {
        if (n.type.name === 'decisionItem') out.push([n.attrs.due, n.firstChild?.textContent]);
        return true;
      });
      return out;
    };
    const block = (items: string) => `<!-- decisions -->\n${items}\n<!-- /decisions -->\n`;
    // After the owner, alone, and on an item with more lines below it.
    // textContent leaves out the mention: what is left of the text is "Test ".
    expect(due(block('- [ ] Test [@Anne](mtxt:user/u1) ~2026-10-30'))).toEqual([
      ['2026-10-30', 'Test '],
    ]);
    expect(due(block('- [x] ~2026-11-02'))).toEqual([['2026-11-02', '']]);
    const nested = block('- [ ] Test ~2026-10-30\n\n  Mere tekst.');
    expect(due(nested)).toEqual([['2026-10-30', 'Test']]);
    expect(normalizeMarkdown(nested)).toBe(nested);
    // Not a date, not last, escaped, or outside the decisions block: text, as it was written.
    expect(due(block('- [ ] Test ~2026-02-31'))).toEqual([[null, 'Test ~2026-02-31']]);
    expect(due(block('- [ ] Test ~2026-10-30 i morgen'))).toEqual([
      [null, 'Test ~2026-10-30 i morgen'],
    ]);
    expect(due(block('- [ ] Test \\~2026-10-30'))).toEqual([[null, 'Test ~2026-10-30']]);
    expect(due(block('- [ ] Test~2026-10-30'))).toEqual([[null, 'Test~2026-10-30']]);
    expect(normalizeMarkdown('- [ ] Test ~2026-10-30\n')).toBe('- [ ] Test \\~2026-10-30\n');
    // Only the first physical line counts (packet 15 review): a soft-wrapped item keeps its date,
    // a date on the continuation line is text, and with a hard break the date goes before the `\`.
    const wrapped = block('- [ ] Test ~2026-10-30\n  mere');
    expect(due(wrapped)).toEqual([['2026-10-30', 'Test mere']]);
    expect(normalizeMarkdown(wrapped)).toBe(block('- [ ] Test mere ~2026-10-30'));
    const continued = block('- [ ] Test\n  mere ~2026-10-30');
    expect(due(continued)).toEqual([[null, 'Test mere ~2026-10-30']]);
    expect(normalizeMarkdown(continued)).toBe(block('- [ ] Test mere \\~2026-10-30'));
    const hard = block('- [ ] Test ~2026-10-30\\\n  mere');
    expect(due(hard)).toEqual([['2026-10-30', 'Testmere']]);
    expect(normalizeMarkdown(hard)).toBe(hard);
    expect(normalizeMarkdown(block('- [ ] Test ~2026-10-30  \n  mere'))).toBe(hard);
    const afterBreak = block('- [ ] Test\\\n  mere ~2026-10-30');
    expect(due(afterBreak)).toEqual([[null, 'Testmere ~2026-10-30']]);
    expect(normalizeMarkdown(afterBreak)).toBe(block('- [ ] Test\\\n  mere \\~2026-10-30'));
    // A tilde typed into the text is escaped, so it stays text after a save.
    const typed = block('- [ ] Test \\~2026-10-30');
    expect(normalizeMarkdown(typed)).toBe(typed);
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
