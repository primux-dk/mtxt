import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { recapDocx } from '../lib/recap/docx';
import { parseMarkdown } from '../lib/recap/markdown';

const FIXTURE = readFileSync(new URL('./fixtures/recap-every-block.md', import.meta.url), 'utf8');
/** A valid 1×1 PNG. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return { zip, xml: await zip.file('word/document.xml')!.async('string') };
}

describe('the Word export', () => {
  it('writes headings, a table, checklists, mentions as names, callouts and the toggle', async () => {
    const bytes = await recapDocx({
      doc: parseMarkdown(FIXTURE),
      title: 'Produktionsmøde, uge 43',
      subtitle: '22. oktober 2026',
      mentionName: (id) => (id === 'user:dev-colleague' ? 'Søren Bak' : undefined),
    });
    const { zip, xml } = await open(bytes);
    expect(xml).toContain('Produktionsmøde, uge 43');
    expect(xml).toContain('w:val="Title"');
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('Skiftetest');
    expect(xml).toContain('Ansvarlig');
    expect(xml).toContain('☐ </w:t>');
    expect(xml).toContain('Test det nye skift torsdag.');
    expect(xml).toMatch(/☑ <\/w:t>.*Saml kapacitetstallene\./s);
    expect(xml).toContain('@Søren Bak');
    expect(xml).toContain('@Speaker 3');
    expect(xml).not.toContain('mtxt:');
    expect(xml).toContain('Åbne spørgsmål til næste møde');
    expect(xml).toContain('w:fill="EEF1ED"');
    expect(xml).toContain('w:fill="F6E3DC"');
    expect(xml).toContain('Consolas');
    // The table of contents lists the headings.
    expect(xml.match(/Næste skridt/g)?.length).toBeGreaterThanOrEqual(2);
    expect(zip.file('word/numbering.xml')).toBeTruthy();
    expect(xml).toContain('[Tavlen efter mødet]');
  });

  it('embeds an image the meeting holds', async () => {
    const bytes = await recapDocx({
      doc: parseMarkdown(FIXTURE),
      title: 'Møde',
      image: async () => ({ bytes: PNG, type: 'png' }),
    });
    const { zip, xml } = await open(bytes);
    expect(Object.keys(zip.files).some((f) => f.startsWith('word/media/'))).toBe(true);
    expect(xml).not.toContain('[Tavlen efter mødet]');
  });
});
