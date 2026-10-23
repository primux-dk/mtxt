/*
  The recap as a Word document, built with `docx` (MIT) from the same
  document the editor shows (lib/recap/markdown.ts parses the stored body).
  Headings, paragraphs and their marks, lists, checklists as ☐ and ☑,
  tables, callouts as shaded paragraphs, a toggle as its summary in bold
  and then its body, the table of contents as the list of headings,
  mentions as plain names, and images from the meeting's own storage.

  Plain TypeScript with no Next.js imports. Packer.toArrayBuffer needs no
  Node stream, so it runs in a Worker.
*/
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import { IMAGE_SRC } from './extensions';

export interface DocxInput {
  doc: PmNode;
  title: string;
  subtitle?: string;
  /** Bytes and type for an image src; null when it cannot be read. */
  image?: (src: string) => Promise<{ bytes: Uint8Array; type: 'png' | 'jpg' | 'gif' } | null>;
  /** The current name for a mention id (`user:<id>`); the label written in the recap otherwise. */
  mentionName?: (id: string) => string | undefined;
}

const MONO = 'Consolas';
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
];
const SHADE = { note: 'EEF1ED', warning: 'F6E3DC', code: 'F2F2F2' } as const;
const BORDER = { note: '566B45', warning: 'AD5437' } as const;
/** Word's twips: 360 is a quarter inch. */
const INDENT = 360;
const MAX_IMAGE_PX = 600;

type Block = Paragraph | Table;
interface Ctx {
  input: DocxInput;
  images: Map<string, { bytes: Uint8Array; type: 'png' | 'jpg' | 'gif' } | null>;
  headings: { level: number; text: string }[];
  /** Each ordered list restarts its numbers: one numbering instance per list. */
  lists: number;
}
interface Style {
  indent?: number;
  shading?: string;
  border?: string;
  italics?: boolean;
  numbering?: { reference: 'bullets' | 'numbers'; level: number; instance?: number };
  prefix?: string;
  style?: (typeof HEADINGS)[number];
}

/** Pixel size from a PNG, GIF or JPEG header, scaled to fit the page; a fixed box when it cannot tell. */
function imageSize(bytes: Uint8Array, type: 'png' | 'jpg' | 'gif') {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let w = 0;
  let h = 0;
  try {
    if (type === 'png' && bytes.length > 24) {
      w = view.getUint32(16);
      h = view.getUint32(20);
    } else if (type === 'gif' && bytes.length > 10) {
      w = view.getUint16(6, true);
      h = view.getUint16(8, true);
    } else if (type === 'jpg') {
      for (let i = 2; i + 9 < bytes.length;) {
        if (bytes[i] !== 0xff) break;
        const marker = bytes[i + 1]!;
        const length = view.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          h = view.getUint16(i + 5);
          w = view.getUint16(i + 7);
          break;
        }
        i += 2 + length;
      }
    }
  } catch {
    w = 0;
  }
  if (!w || !h) return { width: 480, height: 320 };
  const scale = Math.min(1, MAX_IMAGE_PX / w);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const textRun = (text: string, marks: readonly Mark[]) => {
  const has = (name: string) => marks.some((m) => m.type.name === name);
  return new TextRun({
    text,
    bold: has('bold') || undefined,
    italics: has('italic') || undefined,
    strike: has('strike') || undefined,
    font: has('code') ? MONO : undefined,
  });
};

/** A textblock's runs: text with its marks, links, mentions as names, hard breaks. */
function inline(node: PmNode, ctx: Ctx, base: { italics?: boolean } = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  node.forEach((child) => {
    if (child.isText) {
      const marks = base.italics
        ? [...child.marks, node.type.schema.marks.italic!.create()]
        : child.marks;
      const link = child.marks.find((m) => m.type.name === 'link');
      const href = String(link?.attrs.href ?? '');
      const run = textRun(child.text ?? '', marks);
      if (link && /^(https?:|mailto:)/i.test(href)) {
        out.push(
          new ExternalHyperlink({
            link: href,
            children: [new TextRun({ text: child.text ?? '', style: 'Hyperlink' })],
          }),
        );
      } else out.push(run);
    } else if (child.type.name === 'mention') {
      const name = ctx.input.mentionName?.(String(child.attrs.id ?? '')) ?? child.attrs.label ?? '';
      out.push(new TextRun({ text: `@${name}`, bold: true }));
    } else if (child.type.name === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
    } else if (child.textContent) {
      out.push(new TextRun(child.textContent));
    }
  });
  return out;
}

function paragraph(children: ParagraphChild[], style: Style = {}): Paragraph {
  return new Paragraph({
    children: style.prefix ? [new TextRun(style.prefix), ...children] : children,
    heading: style.style,
    numbering: style.numbering,
    indent: style.indent ? { left: style.indent } : undefined,
    shading: style.shading
      ? { type: ShadingType.CLEAR, color: 'auto', fill: style.shading }
      : undefined,
    border: style.border
      ? { left: { style: BorderStyle.SINGLE, size: 18, color: style.border, space: 8 } }
      : undefined,
    spacing: { after: 120 },
  });
}

async function blocks(node: PmNode, ctx: Ctx, style: Style = {}): Promise<Block[]> {
  const out: Block[] = [];
  for (let i = 0; i < node.childCount; i++) out.push(...(await block(node.child(i), ctx, style)));
  return out;
}

async function listItems(
  list: PmNode,
  ctx: Ctx,
  style: Style,
  kind: 'bullets' | 'numbers' | 'check',
): Promise<Block[]> {
  const level = (style.numbering?.level ?? -1) + 1;
  const instance = kind === 'numbers' ? ++ctx.lists : undefined;
  const out: Block[] = [];
  for (let i = 0; i < list.childCount; i++) {
    const item = list.child(i);
    for (let j = 0; j < item.childCount; j++) {
      const child = item.child(j);
      if (j === 0 && child.isTextblock) {
        out.push(
          kind === 'check'
            ? paragraph(inline(child, ctx), {
                ...style,
                numbering: undefined,
                indent: (style.indent ?? 0) + INDENT,
                prefix: item.attrs.checked ? '☑ ' : '☐ ',
              })
            : paragraph(inline(child, ctx), {
                ...style,
                indent: undefined,
                numbering: { reference: kind, level: Math.min(level, 3), instance },
              }),
        );
      } else {
        out.push(
          ...(await block(child, ctx, {
            ...style,
            indent: (style.indent ?? 0) + INDENT,
            numbering:
              kind === 'check'
                ? style.numbering
                : { reference: 'bullets', level: Math.min(level, 3) },
          })),
        );
      }
    }
  }
  return out;
}

async function block(node: PmNode, ctx: Ctx, style: Style = {}): Promise<Block[]> {
  const plain = { ...style, numbering: undefined };
  switch (node.type.name) {
    case 'paragraph':
      return [paragraph(inline(node, ctx, { italics: style.italics }), plain)];
    case 'heading': {
      const level = Math.min(4, Math.max(1, Number(node.attrs.level) || 1));
      return [paragraph(inline(node, ctx), { ...plain, style: HEADINGS[level - 1] })];
    }
    case 'bulletList':
      return listItems(node, ctx, style, 'bullets');
    case 'orderedList':
      return listItems(node, ctx, style, 'numbers');
    case 'taskList':
    case 'decisionList':
      return listItems(node, ctx, style, 'check');
    case 'blockquote':
      return blocks(node, ctx, { ...plain, indent: (style.indent ?? 0) + INDENT, italics: true });
    case 'callout': {
      const kind = node.attrs.kind === 'warning' ? 'warning' : 'note';
      return blocks(node, ctx, { ...plain, shading: SHADE[kind], border: BORDER[kind] });
    }
    case 'details': {
      const out: Block[] = [];
      node.forEach((child) => {
        if (child.type.name === 'detailsSummary') {
          out.push(paragraph([new TextRun({ text: child.textContent, bold: true })], plain));
        }
      });
      const content = node.content.content.find((c) => c.type.name === 'detailsContent');
      if (content) out.push(...(await blocks(content, ctx, plain)));
      return out;
    }
    case 'codeBlock':
      return node.textContent.split('\n').map((line) =>
        paragraph([new TextRun({ text: line || ' ', font: MONO, size: 20 })], {
          ...plain,
          shading: SHADE.code,
        }),
      );
    case 'horizontalRule':
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
          spacing: { after: 120 },
        }),
      ];
    case 'tableOfContents':
      return ctx.headings.map((h) =>
        paragraph([new TextRun(h.text)], {
          ...plain,
          indent: (style.indent ?? 0) + (h.level - 1) * INDENT,
        }),
      );
    case 'table':
      return [await table(node, ctx)];
    case 'image': {
      const src = String(node.attrs.src ?? '');
      const found = IMAGE_SRC.test(src) ? ctx.images.get(src) : null;
      if (found) {
        return [
          new Paragraph({
            children: [
              new ImageRun({
                type: found.type,
                data: found.bytes,
                transformation: imageSize(found.bytes, found.type),
                altText: node.attrs.alt
                  ? {
                      name: String(node.attrs.alt),
                      description: String(node.attrs.alt),
                      title: String(node.attrs.alt),
                    }
                  : undefined,
              }),
            ],
            spacing: { after: 120 },
          }),
        ];
      }
      return [
        paragraph([new TextRun({ text: `[${node.attrs.alt || src}]`, italics: true })], plain),
      ];
    }
    default:
      if (node.isTextblock) return [paragraph(inline(node, ctx), plain)];
      if (node.childCount) return blocks(node, ctx, style);
      return node.textContent ? [paragraph([new TextRun(node.textContent)], plain)] : [];
  }
}

async function table(node: PmNode, ctx: Ctx): Promise<Table> {
  const rows: TableRow[] = [];
  const width = Math.max(1, ...node.content.content.map((r) => r.childCount));
  for (let r = 0; r < node.childCount; r++) {
    const row = node.child(r);
    const cells: TableCell[] = [];
    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);
      const header = cell.type.name === 'tableHeader';
      const content = header
        ? [new Paragraph({ children: [new TextRun({ text: textOf(cell), bold: true })] })]
        : await blocks(cell, ctx);
      cells.push(
        new TableCell({
          children: content.length ? content : [new Paragraph('')],
          shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'FAFAFA' } : undefined,
          width: { size: Math.floor(100 / width), type: WidthType.PERCENTAGE },
        }),
      );
    }
    rows.push(new TableRow({ children: cells, tableHeader: r === 0 }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

const textOf = (node: PmNode) =>
  node.textBetween(0, node.content.size, ' ', (leaf) =>
    leaf.type.name === 'mention' ? `@${leaf.attrs.label ?? ''}` : '',
  );

const numberingLevels = (
  format: (typeof LevelFormat)[keyof typeof LevelFormat],
  text: (l: number) => string,
) =>
  [0, 1, 2, 3].map((level) => ({
    level,
    format,
    text: text(level),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: INDENT * (level + 1), hanging: INDENT / 1.5 } } },
  }));

export async function recapDocx(input: DocxInput): Promise<Uint8Array<ArrayBuffer>> {
  const ctx: Ctx = { input, images: new Map(), headings: [], lists: 0 };
  input.doc.descendants((node) => {
    if (node.type.name === 'heading') {
      ctx.headings.push({ level: Number(node.attrs.level) || 1, text: textOf(node) });
      return false;
    }
    if (node.type.name === 'image' && input.image) {
      const src = String(node.attrs.src ?? '');
      if (IMAGE_SRC.test(src)) ctx.images.set(src, null);
    }
    return true;
  });
  for (const src of ctx.images.keys()) {
    ctx.images.set(src, (await input.image?.(src).catch(() => null)) ?? null);
  }
  const body = await blocks(input.doc, ctx);
  const document = new Document({
    title: input.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: numberingLevels(LevelFormat.BULLET, (l) => ['•', '◦', '▪', '•'][l]!),
        },
        { reference: 'numbers', levels: numberingLevels(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
          ...(input.subtitle
            ? [
                new Paragraph({
                  children: [new TextRun({ text: input.subtitle, color: '666666' })],
                }),
              ]
            : []),
          ...body,
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document)) as Uint8Array<ArrayBuffer>;
}
