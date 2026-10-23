'use client';

/*
  The recap editor (figure 04, docs/design/README.md "Recap editor"): Tiptap 3
  core and open extensions, no Pro package and no template. A toolbar of
  labelled buttons, the `/` block menu, `@` mentions of colleagues and the
  meeting's speakers, block handles in the gutter to add and drag, and the
  version line with the save status. Only the owner edits; a reader gets
  the same document read-only.

  Saving is ./save-state.ts (behaviour.md rules 1 and 4).
*/
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  ChevronRight,
  Code,
  GripVertical,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Minus,
  Plus,
  Quote,
  SquareCheckBig,
  Table as TableIcon,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Extension, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Placeholder } from '@tiptap/extensions';
import { cn } from 'cn';
import { searchMentions, type MentionOption } from '@/app/(app)/meetings/recap-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { allowedImage, recapExtensions, recapMention } from '@/lib/recap/extensions';
import { draftsFor, deleteDraft, type LocalDraft } from '@/lib/recap/local-draft';
import { parseMarkdown, toMarkdown } from '@/lib/recap/markdown';
import type { VersionView } from '@/lib/recap/view';
import {
  FLUSH_SAVE,
  ROLLBACK,
  viewOverrides,
  ViewContext,
  type DecisionChange,
} from './node-views';

/** The transaction that takes the server's stored text: kept locally, not saved again. */
const NORMALIZED = 'recapNormalized';
import { useAutosave, type SaveState, type Undone } from './save-state';
import { createMenu, SuggestionMenu, type MenuItem } from './suggestion-menu';

export interface RecapEditorProps {
  meetingId: string;
  recapId: string;
  owner: boolean;
  current: VersionView | null;
  bodyMd: string;
  /** The number of the newest AI version, for "AI draft v1, edited by Mette v4". */
  lastAi: number | null;
  /** The panel's head: the template select, Versions, Regenerate. */
  head?: React.ReactNode;
  /** Above the toolbar: a draft running or failed. */
  notice?: React.ReactNode;
  /** A version this editor made landed. */
  onVersion?: (version: VersionView) => void;
  /** Restore in the versions panel goes through the editor, so it adopts the new version. */
  registerAdopt?: (adopt: (version: VersionView, bodyMd: string) => void) => void;
}

type BlockItem = MenuItem & { run: (editor: Editor, range: Range) => void };

const UNDONE = {
  tick: 'status.tickUndone',
  due: 'status.dueUndone',
  both: 'status.bothUndone',
} as const satisfies Record<NonNullable<Undone>, string>;

/** Says which version is current and who made it; the status word follows. */
export function VersionLine({
  current,
  lastAi,
  save,
}: {
  current: VersionView | null;
  lastAi: number | null;
  save?: SaveState;
}) {
  const t = useTranslations('recap');
  const locale = useTranslations('locale')('intl');
  if (!current) return null;
  const line =
    current.author === null
      ? t('versionLine.ai', { version: current.number })
      : lastAi
        ? t('versions', {
            name: current.author || t('versionLine.someone'),
            version: current.number,
            ai: lastAi,
          })
        : t('versionLine.human', {
            name: current.author || t('versionLine.someone'),
            version: current.number,
          });
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  return (
    <div
      data-testid="recap-version"
      className="flex flex-wrap items-center gap-x-1 border-b border-line-subtle px-5 py-2.5 text-xs leading-[1.6] text-muted-foreground max-shell:px-4"
    >
      <span>{line}</span>
      {save && (
        <span role="status" aria-live="polite" className="contents">
          {save.status === 'conflict' ? (
            <span className="inline-flex flex-wrap items-center gap-x-1 text-destructive">
              <span aria-hidden="true">·</span>
              <TriangleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
              {save.conflict
                ? t('status.changedBy', {
                    name: save.conflict.author ?? t('versionLine.aiName'),
                    time: when(save.conflict.createdAt),
                  })
                : t('status.changedElsewhere')}
              {save.undone && <span>· {t(UNDONE[save.undone])}</span>}
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="font-[550] underline underline-offset-4"
                onClick={() => window.location.reload()}
              >
                {t('status.reload')}
              </button>
            </span>
          ) : (
            <span
              className={cn(
                save.status === 'saved' && 'text-accent-foreground',
                save.status === 'unsaved' && 'text-destructive',
              )}
            >
              <span aria-hidden="true">· </span>
              {save.status === 'saved'
                ? t('status.saved')
                : save.status === 'saving'
                  ? t('status.saving')
                  : t('status.notSaved')}
              {save.status === 'unsaved' && save.problem && (
                <span className="text-muted-foreground">
                  {' '}
                  · {t(`status.problem.${save.problem}`)}
                </span>
              )}
              {save.undone && (
                <span className="text-muted-foreground"> · {t(UNDONE[save.undone])}</span>
              )}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/** A roving-tabindex toolbar: Tab enters once, the arrow keys move, Home and End jump. */
function Toolbar({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = () => [
    ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ];
  useEffect(() => {
    const list = buttons();
    list.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
  });
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      className="flex flex-wrap items-center gap-1 border-b border-line-subtle px-4 py-2 max-shell:px-3"
      onFocus={(e) => {
        const list = buttons();
        list.forEach((b) => (b.tabIndex = b === (e.target as Element) ? 0 : -1));
      }}
      onKeyDown={(e) => {
        const list = buttons();
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        const next =
          e.key === 'ArrowRight'
            ? (at + 1) % list.length
            : e.key === 'ArrowLeft'
              ? (at - 1 + list.length) % list.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? list.length - 1
                  : -1;
        if (next < 0) return;
        e.preventDefault();
        list[next]!.focus();
      }}
    >
      {children}
    </div>
  );
}

function ToolButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
  wide,
  buttonRef,
}: {
  buttonRef?: React.Ref<HTMLButtonElement>;
  label: string;
  pressed?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={wide ? undefined : label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-[4px] text-[13px] transition-[background-color,color] hover:bg-secondary disabled:opacity-50 max-shell:min-h-11',
        wide ? 'px-2 text-xs text-muted-foreground' : 'w-8 max-shell:w-11',
        pressed && 'bg-accent text-accent-foreground',
      )}
    >
      {children}
      {wide && <span>{label}</span>}
    </button>
  );
}

async function uploadImage(meetingId: string, file: File): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/meetings/${meetingId}/recap/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) return null;
    return ((await response.json()) as { src: string }).src;
  } catch {
    return null;
  }
}

export function RecapEditor(props: RecapEditorProps) {
  const { meetingId, recapId, owner } = props;
  const t = useTranslations('recap');
  const te = useTranslations('editor');
  const intl = useTranslations('locale')('intl');
  useLocale();
  const editorRef = useRef<Editor | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageNote, setImageNote] = useState<string | null>(null);
  const [offered, setOffered] = useState<LocalDraft | null>(null);
  const [hover, setHover] = useState<{ pos: number; size: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const pendingImage = useRef<Range | null>(null);

  const read = useCallback(
    () => (editorRef.current ? toMarkdown(editorRef.current.state.doc) : props.bodyMd),
    [props.bodyMd],
  );
  /**
   * Decision ticks and due dates the server has not confirmed: their place
   * among the decisions, the change, and the save that carries them (null
   * until one starts). A refused save rolls back exactly its own (rule 2).
   */
  const pending = useRef<(DecisionChange & { ordinal: number; carriedBy: number | null })[]>([]);
  const {
    state: save,
    changed,
    adopt,
    restoreLocal,
  } = useAutosave({
    meetingId,
    recapId,
    initial: props.current,
    initialMd: props.bodyMd,
    read,
    onSaveStart: (seq) => {
      for (const change of pending.current) change.carriedBy ??= seq;
    },
    onSaved: (version, seq) => {
      pending.current = pending.current.filter((change) => change.carriedBy !== seq);
      props.onVersion?.(version);
    },
    // The stored text differs (a foreign mention or image went): change only what differs,
    // so the selection maps through the change and the caret stays in the same text.
    onNormalized: (bodyMd) => {
      const e = editorRef.current;
      if (!e) return;
      const next = e.schema.nodeFromJSON(parseMarkdown(bodyMd).toJSON());
      const doc = e.state.doc;
      const start = doc.content.findDiffStart(next.content);
      if (start === null) return;
      let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
      // A repeated run of text can make the ends overlap the start: move both past it.
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      const tr = e.state.tr.replace(start, endA, next.slice(start, endB));
      e.view.dispatch(tr.setMeta(NORMALIZED, true).setMeta('addToHistory', false));
    },
    onRefused: (seq): Undone => {
      const e = editorRef.current;
      const changes = pending.current.filter((change) => change.carriedBy === seq);
      pending.current = pending.current.filter((change) => change.carriedBy !== seq);
      if (!e || !changes.length) return null;
      const items: number[] = [];
      e.state.doc.descendants((n, pos) => {
        if (n.type.name === 'decisionItem') items.push(pos);
        return n.type.name !== 'decisionItem';
      });
      const tr = e.state.tr;
      const undone = new Set<'tick' | 'due'>();
      // Newest first, so two changes to one item end where the first began.
      for (const change of [...changes].reverse()) {
        const at = items[change.ordinal];
        const node = at === undefined ? null : tr.doc.nodeAt(at);
        if (!node || node.type.name !== 'decisionItem') continue;
        if (change.attr === 'checked') {
          if (Boolean(node.attrs.checked) !== change.value) continue;
          tr.setNodeMarkup(at!, undefined, { ...node.attrs, checked: !change.value });
          undone.add('tick');
        } else {
          if ((node.attrs.due ?? null) !== change.value) continue;
          tr.setNodeMarkup(at!, undefined, { ...node.attrs, due: change.previous });
          undone.add('due');
        }
      }
      if (!undone.size) return null;
      e.view.dispatch(tr.setMeta(ROLLBACK, true).setMeta('addToHistory', false));
      return undone.size === 2 ? 'both' : undone.has('tick') ? 'tick' : 'due';
    },
  });

  const blockMenu = useMemo(() => createMenu<BlockItem>(`recap-blocks-${recapId}`), [recapId]);
  const mentionMenu = useMemo(() => createMenu<MenuItem>(`recap-mentions-${recapId}`), [recapId]);

  const blocks = useMemo<BlockItem[]>(() => {
    const icon = (I: typeof Bold) => <I className="size-4" strokeWidth={1.5} />;
    // The command applies to the block the `/` was typed in when it is otherwise empty; else to a new one below.
    const at = (e: Editor, r: Range) => {
      e.chain().focus().deleteRange(r).run();
      const { $from } = e.state.selection;
      if ($from.parent.isTextblock && $from.parent.textContent.trim() && $from.depth > 0) {
        const after = $from.after();
        e.chain()
          .insertContentAt(after, { type: 'paragraph' })
          .setTextSelection(after + 1)
          .run();
      }
      return e.chain().focus();
    };
    return [
      {
        id: 'h1',
        label: te('block.heading1'),
        icon: icon(Heading1),
        run: (e, r) => at(e, r).setNode('heading', { level: 1 }).run(),
      },
      {
        id: 'h2',
        label: te('block.heading2'),
        icon: icon(Heading2),
        run: (e, r) => at(e, r).setNode('heading', { level: 2 }).run(),
      },
      {
        id: 'h3',
        label: te('block.heading3'),
        icon: icon(Heading3),
        run: (e, r) => at(e, r).setNode('heading', { level: 3 }).run(),
      },
      {
        id: 'bullets',
        label: te('block.bulletList'),
        icon: icon(List),
        run: (e, r) => at(e, r).toggleBulletList().run(),
      },
      {
        id: 'numbers',
        label: te('block.orderedList'),
        icon: icon(ListOrdered),
        run: (e, r) => at(e, r).toggleOrderedList().run(),
      },
      {
        id: 'checklist',
        label: te('block.checklist'),
        icon: icon(ListChecks),
        run: (e, r) => at(e, r).toggleTaskList().run(),
      },
      {
        id: 'decisions',
        label: te('block.decisions'),
        icon: icon(SquareCheckBig),
        run: (e, r) =>
          at(e, r)
            .insertContent({
              type: 'decisionList',
              content: [{ type: 'decisionItem', content: [{ type: 'paragraph' }] }],
            })
            .run(),
      },
      {
        id: 'quote',
        label: te('block.quote'),
        icon: icon(Quote),
        run: (e, r) => at(e, r).toggleBlockquote().run(),
      },
      {
        id: 'note',
        label: te('block.note'),
        icon: icon(Info),
        run: (e, r) => at(e, r).wrapIn('callout', { kind: 'note' }).run(),
      },
      {
        id: 'warning',
        label: te('block.warning'),
        icon: icon(TriangleAlert),
        run: (e, r) => at(e, r).wrapIn('callout', { kind: 'warning' }).run(),
      },
      {
        id: 'toggle',
        label: te('block.toggle'),
        icon: icon(ChevronRight),
        run: (e, r) => at(e, r).setDetails().run(),
      },
      {
        id: 'toc',
        label: te('block.toc'),
        icon: icon(ListTree),
        run: (e, r) => at(e, r).insertContent({ type: 'tableOfContents' }).run(),
      },
      {
        id: 'table',
        label: te('block.table'),
        icon: icon(TableIcon),
        run: (e, r) => at(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      },
      {
        id: 'divider',
        label: te('block.divider'),
        icon: icon(Minus),
        run: (e, r) => at(e, r).setHorizontalRule().run(),
      },
      {
        id: 'code',
        label: te('block.code'),
        icon: icon(Code),
        run: (e, r) => at(e, r).toggleCodeBlock().run(),
      },
      {
        id: 'image',
        label: te('block.image'),
        icon: icon(ImageIcon),
        run: (e, r) => {
          at(e, r).run();
          pendingImage.current = { from: e.state.selection.from, to: e.state.selection.from };
          fileRef.current?.click();
        },
      },
    ];
  }, [te]);

  const extensions = useMemo(() => {
    const slash = Extension.create({
      name: 'slashMenu',
      addProseMirrorPlugins() {
        return [
          Suggestion<BlockItem, BlockItem>({
            editor: this.editor,
            pluginKey: new PluginKey('slashMenu'),
            char: '/',
            // At the start of a word only.
            allowedPrefixes: [' '],
            items: ({ query }) => {
              const q = query.toLocaleLowerCase();
              return blocks.filter(
                (b) => !q || b.label.toLocaleLowerCase().includes(q) || b.id.includes(q),
              );
            },
            command: ({ editor, range, props: item }) => item.run(editor, range),
            render: blockMenu.render,
          }),
        ];
      },
    });
    const mention = recapMention({
      char: '@',
      pluginKey: new PluginKey('mentionMenu'),
      allowedPrefixes: [' ', '('],
      items: async ({ query }) => {
        const result = await searchMentions(meetingId, query);
        return result.ok
          ? result.options.map((o: MentionOption) => ({
              id: o.id,
              label: o.label,
              detail: o.detail ?? te('mention.speaker'),
            }))
          : [];
      },
      command: ({ editor, range, props: item }) => {
        const option = item as unknown as MenuItem;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: 'mention', attrs: { id: option.id, label: option.label } },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: mentionMenu.render as never,
    });
    // An image is this meeting's own or becomes its alt text, however it arrives: paste, drop, insert.
    const ownImages = Extension.create({
      name: 'ownImages',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey('ownImages'),
            appendTransaction(transactions, _old, state) {
              if (!transactions.some((tr) => tr.docChanged)) return null;
              const foreign: { pos: number; size: number; alt: string }[] = [];
              state.doc.descendants((node, pos) => {
                if (node.type.name === 'image' && !allowedImage(node.attrs.src, meetingId)) {
                  foreign.push({
                    pos,
                    size: node.nodeSize,
                    alt: String(node.attrs.alt ?? '').trim(),
                  });
                }
                return true;
              });
              if (!foreign.length) return null;
              const tr = state.tr;
              for (const image of foreign.reverse()) {
                const text = image.alt ? state.schema.text(image.alt) : null;
                tr.replaceWith(
                  image.pos,
                  image.pos + image.size,
                  state.schema.nodes.paragraph!.create(null, text),
                );
              }
              return tr;
            },
          }),
        ];
      },
    });
    return [
      ...recapExtensions({ overrides: { ...viewOverrides, mention } }),
      ownImages,
      Placeholder.configure({ placeholder: t('placeholder'), showOnlyWhenEditable: true }),
      slash,
    ];
  }, [blocks, blockMenu, mentionMenu, meetingId, t, te]);

  const editor = useEditor(
    {
      extensions,
      content: parseMarkdown(props.bodyMd).toJSON(),
      editable: owner,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'recap-body',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': owner ? t('editorLabel') : t('readerLabel'),
          ...(owner ? {} : { 'aria-readonly': 'true' }),
        },
      },
      onUpdate: ({ transaction, editor: e }) => {
        if (transaction.getMeta(ROLLBACK) || transaction.getMeta(NORMALIZED)) {
          return changed(false, true);
        }
        const change = transaction.getMeta(FLUSH_SAVE) as DecisionChange | undefined;
        if (change) {
          let ordinal = 0;
          e.state.doc.descendants((n, pos) => {
            if (n.type.name === 'decisionItem' && pos < change.pos) ordinal++;
            return n.type.name !== 'decisionItem';
          });
          pending.current.push({ ...change, ordinal, carriedBy: null });
        }
        changed(Boolean(change));
      },
    },
    [extensions],
  );
  editorRef.current = editor;

  // Unsaved text from an earlier visit: restored when it was written on this version, offered when not.
  useEffect(() => {
    if (!editor || !owner) return;
    let cancelled = false;
    void draftsFor(recapId)
      .then((drafts) => {
        if (cancelled || !drafts.length) return;
        const same = drafts.find((d) => d.baseVersionId === (props.current?.id ?? null));
        if (same && same.bodyMd !== props.bodyMd) {
          editor.commands.setContent(parseMarkdown(same.bodyMd).toJSON(), { emitUpdate: false });
          restoreLocal(props.current?.id ?? null);
          return;
        }
        const older = drafts.find(
          (d) => d.baseVersionId !== (props.current?.id ?? null) && d.bodyMd !== props.bodyMd,
        );
        if (older) setOffered(older);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    props.registerAdopt?.((version, bodyMd) => {
      editor?.commands.setContent(parseMarkdown(bodyMd).toJSON(), { emitUpdate: false });
      adopt(version, bodyMd);
    });
  }, [editor, adopt, props]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            heading: e.isActive('heading'),
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            bullets: e.isActive('bulletList'),
            link: e.isActive('link'),
            undo: e.can().undo(),
          }
        : null,
  });

  const onFile = async (file: File) => {
    if (!editor) return;
    setImageNote(te('image.uploading'));
    const src = await uploadImage(meetingId, file);
    if (!src) {
      setImageNote(te('image.failed'));
      return;
    }
    setImageNote(null);
    const at = pendingImage.current;
    pendingImage.current = null;
    const chain = editor.chain().focus();
    (at ? chain.setTextSelection(at.from) : chain)
      .setImage({ src, alt: file.name.replace(/\.[a-z0-9]+$/i, '') })
      .run();
  };

  return (
    <ViewContext.Provider value={{ locale: intl }}>
      {props.head}
      <VersionLine current={save.current} lastAi={props.lastAi} save={owner ? save : undefined} />
      {props.notice}
      {offered && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-line-subtle bg-accent-tint-soft px-5 py-3 text-sm max-shell:px-4"
        >
          <span className="grow">
            {t('local.offer', {
              time: new Intl.DateTimeFormat(intl, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(offered.savedAt),
            })}
          </span>
          <Button
            onClick={() => {
              editor?.commands.setContent(parseMarkdown(offered.bodyMd).toJSON(), {
                emitUpdate: false,
              });
              void deleteDraft(recapId, offered.baseVersionId);
              setOffered(null);
              restoreLocal(save.current?.id ?? null);
            }}
          >
            {t('local.use')}
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              void deleteDraft(recapId, offered.baseVersionId);
              setOffered(null);
            }}
          >
            {t('local.discard')}
          </Button>
        </div>
      )}
      {owner && editor && (
        <Toolbar label={t('toolbar.label')}>
          <ToolButton
            label={t('toolbar.heading')}
            pressed={active?.heading}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            <Heading aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <ToolButton
            label={t('toolbar.bold')}
            pressed={active?.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold aria-hidden="true" className="size-4" strokeWidth={2} />
          </ToolButton>
          <ToolButton
            label={t('toolbar.italic')}
            pressed={active?.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <ToolButton
            label={t('toolbar.bulletList')}
            pressed={active?.bullets}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <ToolButton
            buttonRef={linkButton}
            label={t('toolbar.link')}
            pressed={active?.link}
            onClick={() => setLinkOpen(true)}
          >
            <LinkIcon aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </ToolButton>
          <span className="grow" />
          <ToolButton
            wide
            label={t('toolbar.undo')}
            disabled={!active?.undo}
            onClick={() => editor.chain().focus().undo().run()}
          >
            <Undo2 aria-hidden="true" className="size-4" strokeWidth={1.5} />
          </ToolButton>
        </Toolbar>
      )}
      <div className="relative">
        {owner && editor && (
          <DragHandle
            editor={editor}
            onNodeChange={({ node, pos }) => setHover(node ? { pos, size: node.nodeSize } : null)}
            className="recap-handle"
          >
            <button
              type="button"
              aria-label={te('handle.add')}
              // A mouse affordance; the keyboard has the `/` menu.
              tabIndex={-1}
              className="recap-handle-button"
              onClick={() => {
                if (!hover) return;
                const at = hover.pos + hover.size;
                editor
                  .chain()
                  .insertContentAt(at, {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '/' }],
                  })
                  .focus(at + 2)
                  .run();
              }}
            >
              <Plus aria-hidden="true" className="size-4" strokeWidth={1.5} />
            </button>
            <span
              aria-hidden="true"
              title={te('handle.drag')}
              className="recap-handle-button cursor-grab"
              data-drag-handle
            >
              <GripVertical className="size-4" strokeWidth={1.5} />
            </span>
          </DragHandle>
        )}
        <EditorContent editor={editor} />
        {!editor && <RecapStatic bodyMd={props.bodyMd} />}
      </div>
      {owner && (
        <>
          <p className="px-5 pb-5 text-xs text-muted-foreground max-shell:px-4">
            {t('editorHint')}
          </p>
          <p role="status" className="sr-only">
            {imageNote}
          </p>
          {imageNote && (
            <p className="px-5 pb-4 text-xs text-muted-foreground max-shell:px-4">{imageNote}</p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = '';
            }}
          />
          <SuggestionMenu menu={blockMenu} label={te('menu.blocks')} empty={te('menu.noBlocks')} />
          <SuggestionMenu
            menu={mentionMenu}
            label={te('menu.mentions')}
            empty={te('menu.noPeople')}
          />
          {editor && (
            <LinkDialog
              open={linkOpen}
              onOpenChange={setLinkOpen}
              editor={editor}
              returnFocus={linkButton}
            />
          )}
        </>
      )}
    </ViewContext.Provider>
  );
}

/** The document before the editor mounts (and without script): the same markdown, rendered plainly. */
function RecapStatic({ bodyMd }: { bodyMd: string }) {
  return (
    <div className="recap-body whitespace-pre-wrap" aria-hidden="true">
      {bodyMd.slice(0, 4000)}
    </div>
  );
}

function LinkDialog({
  open,
  onOpenChange,
  editor,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editor: Editor;
  /** Cancelled: focus goes back to the toolbar's Link button. Applied: to the document. */
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const applied = useRef(false);
  const t = useTranslations('editor.link');
  const tc = useTranslations('common');
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    if (open) {
      applied.current = false;
      setValue(String(editor.getAttributes('link').href ?? ''));
      setError(false);
    }
  }, [open, editor]);
  const apply = () => {
    const href = value.trim();
    applied.current = true;
    if (!href) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onOpenChange(false);
      return;
    }
    const url = /^[a-z]+:/i.test(href) ? href : `https://${href}`;
    if (!/^(https?:|mailto:)/i.test(url)) {
      applied.current = false;
      setError(true);
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain
        .insertContent({
          type: 'text',
          text: href,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .run();
    } else chain.setLink({ href: url }).run();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tc('close')}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (applied.current) editor.commands.focus();
          else returnFocus.current?.focus();
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('help')}</DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
          className="grid gap-3"
        >
          <label htmlFor="recap-link" className="text-sm font-[550]">
            {t('field')}
          </label>
          <Input
            id="recap-link"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://"
            aria-invalid={error || undefined}
            aria-describedby={error ? 'recap-link-error' : undefined}
            autoComplete="off"
          />
          {error && (
            <p id="recap-link-error" className="text-sm text-destructive">
              {t('invalid')}
            </p>
          )}
          <DialogFooter>
            <Button variant="quiet" onClick={() => onOpenChange(false)}>
              {tc('cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
