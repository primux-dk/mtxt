'use client';

/*
  The recap's own blocks as the editor shows them: a decision with its
  checkbox and date, a callout with its icon, and the table of contents
  computed from the headings. The schema is lib/recap/extensions.ts; these
  only add the view.
*/
import { createContext, useContext, useEffect, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { Callout, DecisionItem, TableOfContents } from '@/lib/recap/extensions';

export interface RecapViewContext {
  /** The meeting's date, shown with each decision ("22 Oct"). */
  meetingDate: string;
  locale: string;
  /** Owners' current names by decision position, from the rows. */
  owners: (string | null)[];
}

export const ViewContext = createContext<RecapViewContext>({
  meetingDate: '',
  locale: 'en-GB',
  owners: [],
});

/** The `flushSave` meta on a transaction saves at once instead of after the pause; it carries the tick. */
export const FLUSH_SAVE = 'flushSave';
/** A transaction that undoes refused ticks: kept locally, not saved (rule 2). */
export const ROLLBACK = 'recapRollback';

export interface Tick {
  /** The decision item's position in the document when it was ticked. */
  pos: number;
  checked: boolean;
}

function DecisionView({ node, editor, getPos, updateAttributes }: NodeViewProps) {
  const t = useTranslations('recap');
  const { meetingDate, locale } = useContext(ViewContext);
  const task = node.textContent.trim();
  const date = meetingDate
    ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(
        new Date(meetingDate),
      )
    : '';
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
        disabled={!editor.isEditable}
        aria-label={t('decision.markDone', { task: task || t('decision.untitled') })}
        onChange={(e) => {
          // A tick is a change like any other, saved at once (behaviour.md rule 2).
          const pos = typeof getPos === 'function' ? getPos() : undefined;
          if (pos === undefined) return updateAttributes({ checked: e.target.checked });
          editor.view.dispatch(
            editor.state.tr
              .setNodeMarkup(pos, undefined, { ...node.attrs, checked: e.target.checked })
              .setMeta(FLUSH_SAVE, { pos, checked: e.target.checked } satisfies Tick),
          );
        }}
      />
      <div className="min-w-0 grow">
        <NodeViewContent />
        {date && (
          <span contentEditable={false} className="decision-meta">
            <time dateTime={meetingDate.slice(0, 10)}>{date}</time>
          </span>
        )}
      </div>
    </NodeViewWrapper>
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
