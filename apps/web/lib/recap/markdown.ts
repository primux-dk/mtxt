/*
  Markdown in and out of the recap's schema (lib/recap/extensions.ts), with
  prosemirror-markdown (MIT) over markdown-it (MIT). The stored body is
  markdown (recaps.body_md, recap_versions.body_md); the editor, the reader's
  view, the Word export and the decisions sync all go through here.

  Beyond CommonMark and GFM tables, task lists and strikethrough:

    > [!NOTE] / > [!WARNING]          callout (a GitHub alert)
    <details><summary>…</summary>      toggle; the body is markdown, up to </details>
    <!-- toc -->                       table of contents
    <!-- decisions --> … <!-- /decisions -->   the decisions block: a checklist
    - [ ] Text ~2026-10-30            a decision's due date, last on its first line
    [@Name](mtxt:user/<id>)           mention of a colleague (speaker/<id> for a speaker)

  No other HTML is let through: an HTML block or tag that is not one of the
  above becomes literal text. Images are kept only when they point at the
  meeting's own image route (IMAGE_SRC); anything else becomes its alt text.

  Plain TypeScript with no Next.js imports: the queue consumer uses it too.
*/
import { getSchema } from '@tiptap/core';
import MarkdownIt from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import {
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import { allowedImage, dueDate, MENTION_ID, recapExtensions } from './extensions';

let cachedSchema: Schema | null = null;
/** The recap schema, built once. */
export function recapSchema(): Schema {
  cachedSchema ??= getSchema(recapExtensions());
  return cachedSchema;
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;
const TASK = /^\[([ xX])\][ \t]+/;
/**
 * A decision's due date: `~` and an ISO date, the last word of the item's
 * first physical line, before a hard break's `\` if it has one. Read on the
 * raw source, so an escaped `\~2026-10-30` stays text, and a date on a
 * continuation line is text too (packet 15 review).
 */
const DUE = /(?:^|[ \t])~(\d{4}-\d{2}-\d{2})[ \t]*\\?[ \t]*$/;
const DUE_TEXT = /[ \t]*~\d{4}-\d{2}-\d{2}[ \t]*$/;
const DETAILS_OPEN = /^<details(?:\s+open)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i;
const DETAILS_INLINE =
  /^<details(?:\s+open)?\s*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>\s*$/i;
const DETAILS_CLOSE = /^<\/details>\s*$/i;
const COMMENT = /^<!--\s*(toc|decisions|\/decisions)\s*-->\s*$/i;

const decodeHtml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
const encodeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tokenizer(): MarkdownIt {
  const md = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
  md.core.ruler.push('mtxt_blocks', (state) => {
    state.tokens = rewriteBlocks(state, md);
  });
  return md;
}

/** A token of the given type, like markdown-it makes them. */
function tok(state: StateCore, type: string, tag: string, nesting: -1 | 0 | 1): Token {
  return new state.Token(type, tag, nesting);
}

/** An inline token holding `text` as plain text. */
function plainInline(state: StateCore, text: string): Token {
  const inline = tok(state, 'inline', '', 0);
  inline.content = text;
  const child = tok(state, 'text', '', 0);
  child.content = text;
  inline.children = [child];
  return inline;
}

/** A paragraph of literal text: what unknown HTML becomes. */
function literal(state: StateCore, text: string): Token[] {
  return [
    tok(state, 'paragraph_open', 'p', 1),
    plainInline(state, text),
    tok(state, 'paragraph_close', 'p', -1),
  ];
}

/**
 * The block rewrites: callouts, toggles, the table of contents, the
 * decisions block, task lists, table cells wrapped in paragraphs, and the
 * inline rewrites (mentions, HTML as text, images held to the image route).
 */
function rewriteBlocks(state: StateCore, md: MarkdownIt): Token[] {
  const input = state.tokens;
  const out: Token[] = [];
  /** Open containers we rewrote, so their close tokens are rewritten to match. */
  const quotes: ('callout' | 'blockquote')[] = [];
  const lists: ('task' | 'bullet' | 'decision')[] = [];
  const items: ('task' | 'list' | 'decision')[] = [];
  let details = 0;
  /** `<!-- decisions -->` was just seen: the list that follows is the decisions block. */
  let pendingDecisions = false;

  const closeDetails = () => {
    out.push(
      tok(state, 'details_content_close', 'div', -1),
      tok(state, 'details_close', 'details', -1),
    );
    details--;
  };
  const openDetails = (summary: string) => {
    out.push(
      tok(state, 'details_open', 'details', 1),
      tok(state, 'details_summary_open', 'summary', 1),
      plainInline(state, decodeHtml(summary.trim())),
      tok(state, 'details_summary_close', 'summary', -1),
      tok(state, 'details_content_open', 'div', 1),
    );
    details++;
  };

  for (let i = 0; i < input.length; i++) {
    const t = input[i]!;
    const pending = pendingDecisions;
    pendingDecisions = false;
    switch (t.type) {
      case 'html_block': {
        const html = t.content.trim();
        const comment = COMMENT.exec(html);
        if (comment) {
          const what = comment[1]!.toLowerCase();
          if (what === 'toc') out.push(tok(state, 'toc', 'nav', 0));
          // The block is the list right after the opening marker; the closing one only reads well.
          else if (what === 'decisions')
            pendingDecisions = lists.length === 0 && quotes.length === 0;
          break;
        }
        const inline = DETAILS_INLINE.exec(html);
        if (inline) {
          openDetails(inline[1]!);
          const before = out.length;
          const body = inline[2]!.trim();
          if (body) out.push(...md.parse(body, state.env));
          if (out.length === before) out.push(...literal(state, ''));
          closeDetails();
          break;
        }
        const open = DETAILS_OPEN.exec(html);
        if (open) {
          openDetails(open[1] ?? '');
          break;
        }
        if (DETAILS_CLOSE.test(html) && details > 0) {
          // An empty body still needs a block.
          if (out.at(-1)?.type === 'details_content_open') out.push(...literal(state, ''));
          closeDetails();
          break;
        }
        out.push(...literal(state, t.content.replace(/\n$/, '')));
        break;
      }
      case 'blockquote_open': {
        const inline = input[i + 2];
        const match =
          input[i + 1]?.type === 'paragraph_open' && inline?.type === 'inline'
            ? ALERT.exec(inline.content)
            : null;
        if (!match) {
          quotes.push('blockquote');
          out.push(t);
          break;
        }
        const kind = /WARNING|CAUTION/i.test(match[1]!) ? 'warning' : 'note';
        const callout = tok(state, 'callout_open', 'aside', 1);
        callout.attrSet('kind', kind);
        out.push(callout);
        quotes.push('callout');
        // The marker goes; a paragraph left empty goes with it.
        const children = inline!.children ?? [];
        const first = children[0];
        if (first?.type === 'text') first.content = first.content.replace(ALERT, '');
        while (children[0] && children[0].type === 'text' && children[0].content === '')
          children.shift();
        if (children[0]?.type === 'softbreak') children.shift();
        inline!.content = inline!.content.replace(ALERT, '').replace(/^\n/, '');
        if (children.length === 0) i += 3; // paragraph_open, inline, paragraph_close
        break;
      }
      case 'blockquote_close':
        out.push(quotes.pop() === 'callout' ? tok(state, 'callout_close', 'aside', -1) : t);
        break;
      case 'bullet_list_open': {
        if (pending) {
          lists.push('decision');
          out.push(tok(state, 'decisions_open', 'ul', 1));
          break;
        }
        const task = isTaskList(input, i);
        lists.push(task ? 'task' : 'bullet');
        out.push(task ? tok(state, 'task_list_open', 'ul', 1) : t);
        break;
      }
      case 'bullet_list_close': {
        const kind = lists.pop();
        out.push(
          kind === 'decision'
            ? tok(state, 'decisions_close', 'ul', -1)
            : kind === 'task'
              ? tok(state, 'task_list_close', 'ul', -1)
              : t,
        );
        break;
      }
      case 'ordered_list_open':
        lists.push('bullet');
        out.push(t);
        break;
      case 'ordered_list_close':
        lists.pop();
        out.push(t);
        break;
      case 'list_item_open': {
        const kind = lists.at(-1);
        if (kind === 'task' || kind === 'decision') {
          const inline = input[i + 2];
          const match = inline?.type === 'inline' ? TASK.exec(inline.content) : null;
          const item = tok(
            state,
            kind === 'task' ? 'task_item_open' : 'decision_item_open',
            'li',
            1,
          );
          item.attrSet('checked', match && match[1] !== ' ' ? 'true' : 'false');
          if (match && inline) {
            inline.content = inline.content.replace(TASK, '');
            const first = inline.children?.[0];
            if (first?.type === 'text') first.content = first.content.replace(TASK, '');
          }
          if (kind === 'decision' && inline?.type === 'inline') {
            const due = takeDue(inline);
            if (due) item.attrSet('due', due);
          }
          items.push(kind === 'task' ? 'task' : 'decision');
          out.push(item);
        } else {
          items.push('list');
          out.push(t);
        }
        break;
      }
      case 'list_item_close': {
        const kind = items.pop();
        out.push(
          kind === 'task'
            ? tok(state, 'task_item_close', 'li', -1)
            : kind === 'decision'
              ? tok(state, 'decision_item_close', 'li', -1)
              : t,
        );
        break;
      }
      case 'thead_open':
      case 'thead_close':
      case 'tbody_open':
      case 'tbody_close':
        break;
      case 'th_open':
      case 'td_open':
        out.push(t, tok(state, 'paragraph_open', 'p', 1));
        break;
      case 'th_close':
      case 'td_close':
        out.push(tok(state, 'paragraph_close', 'p', -1), t);
        break;
      case 'paragraph_open': {
        // An image on its own line is a block; an image inside text keeps only its alt text.
        const inline = input[i + 1];
        if (inline?.type === 'inline') {
          const children = rewriteInline(state, inline.children ?? []);
          if (children.length === 1 && children[0]!.type === 'image') {
            out.push(children[0]!);
            i += 2;
            break;
          }
          inline.children = children.map((c) => {
            if (c.type !== 'image') return c;
            const text = tok(state, 'text', '', 0);
            text.content = (c.children ?? []).map((x) => x.content).join('');
            return text;
          });
          inline.meta = { rewritten: true };
        }
        out.push(t);
        break;
      }
      case 'inline':
        if (!t.meta?.rewritten) t.children = rewriteInline(state, t.children ?? []);
        out.push(t);
        break;
      default:
        out.push(t);
    }
  }
  while (details > 0) closeDetails();
  return out;
}

/** The due date that ends a decision's first line, taken out of its text; null when there is none. */
function takeDue(inline: Token): string | null {
  const [first, ...rest] = inline.content.split('\n');
  const due = dueDate(DUE.exec(first!)?.[1]);
  const children = inline.children ?? [];
  // The first line's tokens end at the first soft or hard break.
  const brk = children.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
  const at = (brk === -1 ? children.length : brk) - 1;
  const last = children[at];
  if (!due || last?.type !== 'text' || !DUE_TEXT.test(last.content)) return null;
  last.content = last.content.replace(DUE_TEXT, '');
  if (!last.content) children.splice(at, 1);
  inline.content = [first!.replace(/[ \t]*~\d{4}-\d{2}-\d{2}/, ''), ...rest].join('\n');
  return due;
}

/** A bullet list is a task list when every one of its own items starts with `[ ]` or `[x]`. */
function isTaskList(tokens: Token[], start: number): boolean {
  let depth = 0;
  let items = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') depth++;
    if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') {
      depth--;
      if (depth === 0) return items > 0;
    }
    if (depth === 1 && t.type === 'list_item_open') {
      items++;
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') return false;
      if (!TASK.test(inline.content)) return false;
    }
  }
  return false;
}

/** Mentions from `mtxt:` links, HTML as text, images held to the image route. */
function rewriteInline(state: StateCore, children: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < children.length; i++) {
    const t = children[i]!;
    if (t.type === 'link_open') {
      const href = t.attrGet('href') ?? '';
      const target = /^mtxt:(user|speaker)\/([A-Za-z0-9_-]{1,64})$/.exec(href);
      if (target) {
        let label = '';
        let j = i + 1;
        for (; j < children.length && children[j]!.type !== 'link_close'; j++) {
          label += children[j]!.content;
        }
        const mention = tok(state, 'mention', 'span', 0);
        mention.attrSet('id', `${target[1]}:${target[2]}`);
        mention.attrSet('label', label.replace(/^@/, ''));
        out.push(mention);
        i = j;
        continue;
      }
    }
    if (t.type === 'html_inline') {
      const text = tok(state, 'text', '', 0);
      text.content = t.content;
      out.push(text);
      continue;
    }
    if (t.type === 'image' && !allowedImage(t.attrGet('src'), (state.env as ParseEnv).meetingId)) {
      const text = tok(state, 'text', '', 0);
      text.content = (t.children ?? []).map((c) => c.content).join('');
      if (text.content) out.push(text);
      continue;
    }
    out.push(t);
  }
  return out;
}

let cachedParser: MarkdownParser | null = null;
function parser(): MarkdownParser {
  if (cachedParser) return cachedParser;
  const schema = recapSchema();
  const checked = (t: Token) => ({ checked: t.attrGet('checked') === 'true' });
  cachedParser = new MarkdownParser(schema, tokenizer(), {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (t) => ({ start: Number(t.attrGet('start')) || 1 }),
    },
    heading: {
      block: 'heading',
      getAttrs: (t) => ({ level: Math.min(4, Number(t.tag.slice(1)) || 1) }),
    },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: {
      block: 'codeBlock',
      getAttrs: (t) => ({ language: t.info.trim().split(/\s+/)[0] || null }),
      noCloseToken: true,
    },
    hr: { node: 'horizontalRule' },
    image: {
      node: 'image',
      getAttrs: (t) => ({
        src: t.attrGet('src'),
        title: t.attrGet('title') || null,
        alt: t.children?.[0]?.content || null,
      }),
    },
    hardbreak: { node: 'hardBreak' },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    link: {
      mark: 'link',
      getAttrs: (t) => ({ href: t.attrGet('href'), title: t.attrGet('title') || null }),
    },
    code_inline: { mark: 'code', noCloseToken: true },
    callout: { block: 'callout', getAttrs: (t) => ({ kind: t.attrGet('kind') }) },
    details: { block: 'details' },
    details_summary: { block: 'detailsSummary' },
    details_content: { block: 'detailsContent' },
    toc: { node: 'tableOfContents' },
    decisions: { block: 'decisionList' },
    decision_item: {
      block: 'decisionItem',
      getAttrs: (t) => ({ ...checked(t), due: dueDate(t.attrGet('due')) }),
    },
    task_list: { block: 'taskList' },
    task_item: { block: 'taskItem', getAttrs: checked },
    table: { block: 'table' },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader' },
    td: { block: 'tableCell' },
    mention: {
      node: 'mention',
      getAttrs: (t) => {
        const id = t.attrGet('id') ?? '';
        return MENTION_ID.test(id)
          ? { id, label: t.attrGet('label') ?? '' }
          : { id: null, label: '' };
      },
    },
  });
  return cachedParser;
}

interface ParseEnv {
  /** When set, an image is kept only when it is this meeting's own. */
  meetingId?: string;
}

/**
 * The markdown as a recap document. Never throws on odd input: what it
 * cannot place becomes text. With `meetingId`, images of other meetings
 * become their alt text too.
 */
export function parseMarkdown(markdown: string, env: ParseEnv = {}): PmNode {
  const schema = recapSchema();
  try {
    const doc = parser().parse(markdown.replace(/\r\n?/g, '\n'), { ...env });
    doc.check();
    return doc;
  } catch {
    // Last resort: every line a paragraph, so nothing typed is ever lost.
    const lines = markdown.split(/\n{2,}/).filter((l) => l.trim());
    return schema.node(
      'doc',
      null,
      lines.length
        ? lines.map((l) => schema.node('paragraph', null, [schema.text(l)]))
        : [schema.node('paragraph')],
    );
  }
}

type State = MarkdownSerializerState & {
  flushClose(size?: number): void;
  closed: PmNode | null;
  out: string;
};
type NodeSerializer = (state: State, node: PmNode, parent: PmNode, index: number) => void;

const d = defaultMarkdownSerializer.nodes;
const linkText = (s: string) => s.replace(/[\\[\]]/g, '\\$&');

/** One table cell's content on one line. */
function cellText(node: PmNode): string {
  return (
    serializer()
      .serialize(node, { tightLists: true })
      .trim()
      // A cell is not the start of a line: "22. okt." is not a list there.
      .replace(/^(\d+)\\\./, '$1.')
      .replace(/^\\([-+>#])/, '$1')
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '\\|')
  );
}

const nodes: Record<string, NodeSerializer> = {
  blockquote: d.blockquote as NodeSerializer,
  codeBlock: (state, node) => {
    const fence = node.textContent
      .match(/`{3,}/gm)
      ?.reduce((a, b) => (b.length > a.length ? b : a), '');
    const marks = fence && fence.length >= 3 ? '`'.repeat(fence.length + 1) : '```';
    state.write(marks + (node.attrs.language ?? '') + '\n');
    state.text(node.textContent, false);
    state.ensureNewLine();
    state.write(marks);
    state.closeBlock(node);
  },
  heading: (state, node) => {
    state.write(`${'#'.repeat(node.attrs.level as number)} `);
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  horizontalRule: (state, node) => {
    state.write('---');
    state.closeBlock(node);
  },
  bulletList: (state, node) => state.renderList(node, '  ', () => '- '),
  orderedList: (state, node) => {
    const start = (node.attrs.start as number) || 1;
    const width = String(start + node.childCount - 1).length;
    const space = ' '.repeat(width + 2);
    state.renderList(node, space, (i) => {
      const n = String(start + i);
      return ' '.repeat(width - n.length) + n + '. ';
    });
  },
  listItem: (state, node) => state.renderContent(node),
  taskList: (state, node) => state.renderList(node, '  ', () => '- '),
  taskItem: (state, node) => {
    state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
  decisionList: (state, node) => {
    state.write('<!-- decisions -->');
    state.ensureNewLine();
    state.renderList(node, '  ', () => '- ');
    state.flushClose(1);
    state.write('<!-- /decisions -->');
    state.closeBlock(node);
  },
  decisionItem: (state, node) => {
    state.write(node.attrs.checked ? '[x] ' : '[ ] ');
    const due = dueDate(node.attrs.due);
    if (!due) return state.renderContent(node);
    // The date ends the first physical line, after the text and the owner:
    // before the first hard break's `\`, or at the end when there is none.
    node.forEach((child, _, i) => {
      if (i === 0 && child.type.name === 'paragraph') {
        const line = serializer()
          .serialize(recapSchema().node('doc', null, [child]), { tightLists: true })
          .trimEnd();
        const marker = `${line ? ' ' : ''}~${due}`;
        const brk = line.indexOf('\\\n');
        state.text(
          brk === -1 ? line + marker : line.slice(0, brk) + marker + line.slice(brk),
          false,
        );
        state.closeBlock(child);
      } else state.render(child, node, i);
    });
  },
  paragraph: (state, node) => {
    state.renderInline(node);
    state.closeBlock(node);
  },
  image: (state, node) => {
    state.write(
      `![${linkText(node.attrs.alt ?? '')}](${String(node.attrs.src).replace(/[()]/g, '\\$&')}${
        node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''
      })`,
    );
    state.closeBlock(node);
  },
  hardBreak: d.hard_break as NodeSerializer,
  text: d.text as NodeSerializer,
  mention: (state, node) => {
    const match = MENTION_ID.exec(String(node.attrs.id ?? ''));
    const label = `@${linkText(String(node.attrs.label ?? ''))}`;
    state.write(match ? `[${label}](mtxt:${match[1]}/${match[2]})` : label);
  },
  callout: (state, node) => {
    state.wrapBlock('> ', null, node, () => {
      state.write(node.attrs.kind === 'warning' ? '[!WARNING]' : '[!NOTE]');
      state.ensureNewLine();
      state.renderContent(node);
    });
  },
  details: (state, node) => {
    state.write('<details>');
    state.ensureNewLine();
    state.renderContent(node);
    state.write('</details>');
    state.closeBlock(node);
  },
  detailsSummary: (state, node) => {
    state.write(`<summary>${encodeHtml(node.textContent.replace(/\s+/g, ' ').trim())}</summary>`);
    state.closeBlock(node);
  },
  detailsContent: (state, node) => state.renderContent(node),
  tableOfContents: (state, node) => {
    state.write('<!-- toc -->');
    state.closeBlock(node);
  },
  table: (state, node) => {
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cellText(cell)));
      rows.push(cells);
    });
    const width = Math.max(1, ...rows.map((r) => r.length));
    const line = (cells: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] || ' ').join(' | ')} |`;
    rows.forEach((cells, i) => {
      state.write(line(cells));
      state.ensureNewLine();
      if (i === 0) {
        state.write(`|${' --- |'.repeat(width)}`);
        state.ensureNewLine();
      }
    });
    state.closeBlock(node);
  },
  // Rows and cells are written by `table`.
  tableRow: () => {},
  tableHeader: () => {},
  tableCell: () => {},
};

const marks = {
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: defaultMarkdownSerializer.marks.code!,
  link: defaultMarkdownSerializer.marks.link!,
};

let cachedSerializer: MarkdownSerializer | null = null;
function serializer(): MarkdownSerializer {
  cachedSerializer ??= new MarkdownSerializer(
    nodes as unknown as MarkdownSerializer['nodes'],
    marks,
    { hardBreakNodeName: 'hardBreak', strict: false },
  );
  return cachedSerializer;
}

/** The document as markdown, tight lists, ending in one newline. */
export function toMarkdown(doc: PmNode): string {
  const out = serializer().serialize(doc, { tightLists: true }).trimEnd();
  return out ? `${out}\n` : '';
}

/** Markdown through the schema and back: what the editor would store for it. */
export function normalizeMarkdown(markdown: string): string {
  return toMarkdown(parseMarkdown(markdown));
}

/** The document's text for search and snippets: no markdown syntax, mentions as @Name. */
export function plainText(doc: PmNode): string {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (node.isTextblock) {
      blocks.push(
        node.textBetween(0, node.content.size, ' ', (leaf) =>
          leaf.type.name === 'mention' ? `@${leaf.attrs.label ?? ''}` : '',
        ),
      );
      return false;
    }
    return true;
  });
  return blocks.filter((b) => b.trim()).join('\n');
}
