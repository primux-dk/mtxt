'use client';

/*
  The versions panel: every version of the recap, newest first, with who
  made it (AI or a name) and when; a preview of the one chosen, rendered as
  the reader sees it, without a diff; and Restore for the owner, which makes
  a new version from the old body. The shadcn Dialog, so focus is trapped
  while it is open and returns to the Versions button after (rule 11).
*/
import { useEffect, useState, useTransition } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EditorContent, useEditor } from '@tiptap/react';
import { cn } from 'cn';
import {
  recapVersionBody,
  recapVersions,
  restoreRecapVersion,
} from '@/app/(app)/meetings/recap-actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { recapExtensions } from '@/lib/recap/extensions';
import { parseMarkdown } from '@/lib/recap/markdown';
import type { VersionView } from '@/lib/recap/view';
import { viewOverrides } from './node-views';

/** A recap body rendered read-only, as a reader sees it. */
export function RecapView({ bodyMd, label }: { bodyMd: string; label: string }) {
  const editor = useEditor(
    {
      extensions: recapExtensions({ overrides: viewOverrides }),
      content: parseMarkdown(bodyMd).toJSON(),
      editable: false,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'recap-body',
          'aria-label': label,
          'aria-readonly': 'true',
          role: 'document',
        },
      },
    },
    [bodyMd],
  );
  return <EditorContent editor={editor} />;
}

export function useVersionNote() {
  const t = useTranslations('versions');
  return (note: string | null) => {
    const restored = /^restored:(\d+)$/.exec(note ?? '');
    if (restored) return t('note.restored', { version: Number(restored[1]) });
    const chunked = /^chunked:(\d+)$/.exec(note ?? '');
    if (chunked) return t('note.chunked', { parts: Number(chunked[1]) });
    return null;
  };
}

export function VersionsDialog({
  open,
  onOpenChange,
  meetingId,
  owner,
  onRestored,
  returnFocus,
}: {
  /** The button that opened the panel; focus goes back to it when it closes. */
  returnFocus?: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  owner: boolean;
  currentId: string;
  onRestored: (version: VersionView, bodyMd: string) => void;
}) {
  const t = useTranslations('versions');
  const tc = useTranslations('common');
  const intl = useTranslations('locale')('intl');
  const noteOf = useVersionNote();
  const [versions, setVersions] = useState<VersionView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; bodyMd: string } | null>(null);
  const [restoring, startRestore] = useTransition();
  const [restoreFailed, setRestoreFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    setRestoreFailed(false);
    setVersions(null);
    void recapVersions(meetingId)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) return setFailed(true);
        setVersions(result.versions);
        setSelected(result.versions[0]?.id ?? null);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [open, meetingId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void recapVersionBody(meetingId, selected).then((result) => {
      if (!cancelled && result.ok) setPreview({ id: selected, bodyMd: result.bodyMd });
    });
    return () => {
      cancelled = true;
    };
  }, [selected, meetingId]);

  const when = (iso: string) =>
    new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const who = (v: VersionView) => (v.author === null ? t('ai') : v.author || t('someone'));
  const chosen = versions?.find((v) => v.id === selected) ?? null;
  const current = versions?.[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tc('close')}
        className="max-w-[880px]"
        onCloseAutoFocus={(e) => {
          if (!returnFocus?.current) return;
          e.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        {failed ? (
          <p role="alert" className="text-destructive">
            {t('loadFailed')}
          </p>
        ) : !versions ? (
          <p role="status" className="text-muted-foreground">
            {t('loading')}
          </p>
        ) : (
          <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4 max-shell:grid-cols-1">
            <ul
              aria-label={t('list')}
              className="grid max-h-[420px] content-start gap-1 overflow-y-auto max-shell:max-h-[200px]"
            >
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-pressed={v.id === selected}
                    onClick={() => setSelected(v.id)}
                    className={cn(
                      'grid w-full gap-0.5 rounded-control border border-transparent px-3 py-2 text-left hover:bg-secondary',
                      v.id === selected && 'border-accent-line-strong bg-accent-tint',
                    )}
                  >
                    <span className="font-[550]">
                      {t('item', { version: v.number, who: who(v) })}
                      {v.id === current?.id && (
                        <span className="ml-2 text-xs text-accent-foreground">{t('current')}</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {when(v.createdAt)}
                    </span>
                    {noteOf(v.note) && (
                      <span className="text-xs text-muted-foreground">{noteOf(v.note)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <section
              aria-label={chosen ? t('preview', { version: chosen.number }) : t('previewNone')}
              className="max-h-[420px] min-w-0 overflow-y-auto rounded-card border border-border max-shell:max-h-[320px]"
            >
              {preview && preview.id === selected ? (
                <RecapView
                  bodyMd={preview.bodyMd}
                  label={t('preview', { version: chosen?.number ?? 0 })}
                />
              ) : (
                <p role="status" className="p-5 text-muted-foreground">
                  {t('loading')}
                </p>
              )}
            </section>
          </div>
        )}
        <DialogFooter>
          {restoreFailed && (
            <p role="alert" className="mr-auto self-center text-sm text-destructive">
              {t('restoreFailed')}
            </p>
          )}
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            {tc('close')}
          </Button>
          {owner && chosen && chosen.id !== current?.id && (
            <Button
              variant="primary"
              aria-busy={restoring || undefined}
              onClick={() =>
                startRestore(async () => {
                  setRestoreFailed(false);
                  const result = await restoreRecapVersion(meetingId, chosen.id).catch(() => ({
                    ok: false as const,
                  }));
                  if (!result.ok) return setRestoreFailed(true);
                  onRestored(result.version, result.bodyMd);
                  onOpenChange(false);
                })
              }
            >
              <RotateCcw aria-hidden="true" />
              {t('restore', { version: chosen.number })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
