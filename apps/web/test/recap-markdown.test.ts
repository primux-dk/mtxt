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
});
