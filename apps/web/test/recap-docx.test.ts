import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { recapDocx } from '../lib/recap/docx';
import { etagFor } from '../lib/rest/rules';
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
  it('packs the same version to the same bytes, links and times included, for the API ETag', async () => {
    const at = new Date(Date.UTC(2026, 9, 22, 9, 30));
    const make = () =>
      recapDocx({
        doc: parseMarkdown(FIXTURE),
        title: 'Produktionsmøde, uge 43',
        subtitle: '22. oktober 2026',
        at,
        mentionName: () => 'Søren Bak',
        image: async () => ({ bytes: PNG, type: 'png' }),
      });
    const first = await make();
    // Across a zip timestamp's 2-second step.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await make();
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(await etagFor(second)).toBe(await etagFor(first));
    const { zip, xml } = await open(first);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('Id="rIdLink1"');
    expect(xml).toContain('r:id="rIdLink1"');
    expect(rels).not.toMatch(/Id="rId(?!\d+"|Link\d+")/);
    const core = await zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('>2026-10-22T09:30:00Z</dcterms:created>');
    expect(core).toContain('>2026-10-22T09:30:00Z</dcterms:modified>');
    expect(zip.file('word/document.xml')!.date.getTime()).toBe(at.getTime());
  }, 15_000);
});
