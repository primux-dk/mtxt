'use client';

/*
  The recap's own blocks as the editor shows them: a decision with its
  checkbox, its owner and its due date, a callout with its icon, and the
  table of contents computed from the headings. The schema is
  lib/recap/extensions.ts; these only add the view.
*/
import { createContext, useContext, useEffect, useId, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import type { Node as PmNode } from '@tiptap/pm/model';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Callout, DecisionItem, dueDate, TableOfContents } from '@/lib/recap/extensions';

export interface RecapViewContext {
  locale: string;
}

export const ViewContext = createContext<RecapViewContext>({ locale: 'en-GB' });

/** The `flushSave` meta on a transaction saves at once instead of after the pause; it carries the change. */
export const FLUSH_SAVE = 'flushSave';
/** A transaction that undoes refused decision changes: kept locally, not saved (rule 2). */
export const ROLLBACK = 'recapRollback';

/** A tick or a due date set on a decision, saved at once and undone if the server refuses it. */
export type DecisionChange = {
  /** The decision item's position in the document when it changed. */
  pos: number;
} & (
  | { attr: 'checked'; value: boolean }
  | { attr: 'due'; value: string | null; previous: string | null }
);

/** The item's owner as it reads: the first person it mentions. */
function ownerOf(node: PmNode): string | null {
  let owner: string | null = null;
  node.descendants((leaf) => {
    if (owner) return false;
    if (leaf.type.name === 'mention') owner = String(leaf.attrs.label ?? '').trim() || null;
    return true;
  });
  return owner;
}

function DecisionView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const t = useTranslations('recap');
  const { locale } = useContext(ViewContext);
  const task = node.textContent.trim() || t('decision.untitled');
  const owner = ownerOf(node);
  const due = dueDate(node.attrs.due);
  const dueText = due
    ? t('decision.due', {
        date: new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }).format(new Date(`${due}T00:00:00Z`)),
      })
    : null;
  const editable = editor.isEditable;

  /** A tick or a due date is a change like any other, saved at once (behaviour.md rule 2). */
  const change = (attrs: { checked: boolean } | { due: string | null }) => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos === undefined) return updateAttributes(attrs);
    const meta: DecisionChange =
      'checked' in attrs
        ? { pos, attr: 'checked', value: attrs.checked }
        : { pos, attr: 'due', value: attrs.due, previous: due };
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
        .setMeta(FLUSH_SAVE, meta),
    );
  };

  return (
    <NodeViewWrapper
      as="li"
      className="decision"
      data-checked={node.attrs.checked ? 'true' : 'false'}
    >
      <input
        type="checkbox"
        contentEditable={false}
        checked={Boolean(node.attrs.checked)}
        disabled={!editable}
        aria-label={t('decision.markDone', { task })}
        onChange={(e) => change({ checked: e.target.checked })}
      />
      <div className="min-w-0 grow">
        <NodeViewContent />
        {(owner || due || editable) && (
          <span contentEditable={false} className="decision-meta" data-testid="decision-meta">
            {owner && <span className="decision-owner">{owner}</span>}
            {owner && (due || editable) && <span aria-hidden="true"> · </span>}
            {editable ? (
              <DueDatePicker
                due={due}
                label={dueText ?? t('decision.addDue')}
                task={task}
                onChange={(value) => change({ due: value })}
              />
            ) : (
              due && <time dateTime={due}>{dueText}</time>
            )}
          </span>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * "Add due date" or "Due 30 Oct", opening a small picker: the browser's own
 * date field, Save and Clear. Escape or a click outside leaves the date as it was.
 */
function DueDatePicker({
  due,
  label,
  task,
  onChange,
}: {
  due: string | null;
  label: string;
  task: string;
  onChange: (value: string | null) => void;
}) {
  const t = useTranslations('recap.decision');
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(due ?? '');
  const id = useId();
  const valid = dueDate(value);
  const save = () => {
    if (!valid) return;
    setOpen(false);
    if (valid !== due) onChange(valid);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Each opening starts from the date the item has now.
        if (next) setValue(due ?? '');
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={due ? 'decision-due' : 'decision-due decision-due-empty'}
          aria-label={t('dueButton', { label, task })}
        >
          {due ? <time dateTime={due}>{label}</time> : label}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label={t('dueField', { task })}>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor={id} className="text-sm font-[550]">
            {t('dueLabel')}
          </label>
          <Input
            id={id}
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            min="1000-01-01"
            max="9999-12-31"
          />
          <div className="flex flex-wrap justify-end gap-2">
            {due && (
              <Button
                variant="quiet"
                onClick={() => {
                  setOpen(false);
                  onChange(null);
                }}
              >
                {t('clearDue')}
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!valid}>
              {t('saveDue')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function CalloutView({ node }: NodeViewProps) {
  const t = useTranslations('editor');
  const warning = node.attrs.kind === 'warning';
  const Icon = warning ? TriangleAlert : Info;
  return (
    <NodeViewWrapper
      as="aside"
      data-callout=""
      data-kind={warning ? 'warning' : 'note'}
      className="callout"
    >
      <Icon aria-hidden="true" className="callout-icon" strokeWidth={1.5} />
      <span className="sr-only">{warning ? t('block.warning') : t('block.note')}</span>
      <NodeViewContent className="min-w-0 grow" />
    </NodeViewWrapper>
  );
}

function TocView({ editor }: NodeViewProps) {
  const t = useTranslations('editor');
  const read = () => {
    const out: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === 'heading')
        out.push({ level: n.attrs.level as number, text: n.textContent, pos });
      return n.type.name !== 'heading';
    });
    return out;
  };
  const [headings, setHeadings] = useState(read);
  useEffect(() => {
    const update = () => setHeadings(read());
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);
  return (
    <NodeViewWrapper
      as="nav"
      data-toc=""
      className="toc"
      aria-label={t('block.toc')}
      contentEditable={false}
    >
      <p className="toc-title">{t('block.toc')}</p>
      {headings.length === 0 ? (
        <p className="text-muted-foreground">{t('toc.empty')}</p>
      ) : (
        <ol>
          {headings.map((h) => (
            <li key={h.pos} style={{ paddingLeft: `${(h.level - 1) * 16}px` }}>
              <button
                type="button"
                className="toc-link"
                onClick={() => {
                  const dom = editor.view.nodeDOM(h.pos);
                  if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start' });
                  if (editor.isEditable) editor.commands.setTextSelection(h.pos + 1);
                }}
              >
                {h.text || t('toc.untitled')}
              </button>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
}

/** The schema's nodes with their views, for recapExtensions({ overrides }). */
export const viewOverrides = {
  decisionItem: DecisionItem.extend({ addNodeView: () => ReactNodeViewRenderer(DecisionView) }),
  callout: Callout.extend({ addNodeView: () => ReactNodeViewRenderer(CalloutView) }),
  tableOfContents: TableOfContents.extend({ addNodeView: () => ReactNodeViewRenderer(TocView) }),
};
