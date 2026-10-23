/*
  The recap's document schema: Tiptap 3 core with open, MIT extensions only
  (CLAUDE.md: no Tiptap Pro, no Tiptap template code). The same list runs in
  the browser editor, in the server's markdown parser and serializer, in the
  recap job and in the Word export, so all four read one schema.

  No React and no DOM here: the client editor (components/recap) adds node
  views, menus and the drag handle on top of these.

  Own nodes, from the spec's block list: `callout` (a GitHub alert, note or
  warning), `tableOfContents` (computed from the headings when shown),
  `decisionList` and `decisionItem` (the decisions block, synced with the
  `decisions` rows). The toggle is the open `@tiptap/extension-details`.
*/
import { mergeAttributes, Node, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Mention, { type MentionOptions } from '@tiptap/extension-mention';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';

export const CALLOUT_KINDS = ['note', 'warning'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** A note or warning callout. Markdown: `> [!NOTE]` / `> [!WARNING]`. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note' as CalloutKind,
        parseHTML: (el) => (el.getAttribute('data-kind') === 'warning' ? 'warning' : 'note'),
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },
});

/** A table of contents, computed from the document's headings where it is shown. Markdown: `<!-- toc -->`. */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-toc': '' })];
  },
});

/**
 * The decisions block: a checklist whose items are the meeting's `decisions`
 * rows, in order. Markdown: a task list between `<!-- decisions -->` and
 * `<!-- /decisions -->`, so the stored body reads as an ordinary checklist.
 */
export const DecisionList = Node.create({
  name: 'decisionList',
  group: 'block',
  content: 'decisionItem+',
  defining: true,
  parseHTML() {
    return [{ tag: 'ul[data-decisions]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-decisions': '' }), 0];
  },
});

export const DecisionItem = Node.create({
  name: 'decisionItem',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (el) => el.getAttribute('data-checked') === 'true',
        renderHTML: (attrs) => ({ 'data-checked': attrs.checked ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'li[data-decision]', priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes, { 'data-decision': '' }), 0];
  },
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.commands.splitListItem(this.name) };
  },
});

/** `user:<id>` names a colleague, `speaker:<id>` one of the meeting's speakers. */
export const MENTION_ID = /^(user|speaker):([A-Za-z0-9_-]{1,64})$/;

/** The mention node; the client passes its `@` suggestion. */
export function recapMention(suggestion?: MentionOptions['suggestion']) {
  return Mention.extend({
    renderText({ node }) {
      return `@${node.attrs.label ?? ''}`;
    },
  }).configure({
    HTMLAttributes: { class: 'mention' },
    renderHTML({ options, node }) {
      return ['span', mergeAttributes(options.HTMLAttributes), `@${node.attrs.label ?? ''}`];
    },
    deleteTriggerWithBackspace: true,
    ...(suggestion ? { suggestion } : {}),
  });
}

/** Image sources the recap may show: the meeting's own permission-checked image route, nothing remote. */
export const IMAGE_SRC =
  /^\/api\/v1\/meetings\/[A-Za-z0-9_-]{1,64}\/recap\/images\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/;

/**
 * The extensions that define the schema. The client replaces some by name
 * (`overrides`) with node views and its `@` suggestion; the schema stays the same.
 */
export function recapExtensions(
  options: { overrides?: Record<string, AnyExtension> } = {},
): AnyExtension[] {
  const list: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      underline: false,
      // No markdown for these two.
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
        isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ inline: false, allowBase64: false }),
    recapMention(),
    Details.configure({ persist: false, HTMLAttributes: { class: 'details' } }),
    DetailsSummary,
    DetailsContent,
    Callout,
    TableOfContents,
    DecisionList,
    DecisionItem,
  ];
  const overrides = options.overrides ?? {};
  return list.map((extension) => overrides[extension.name] ?? extension);
}
