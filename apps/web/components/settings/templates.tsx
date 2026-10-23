'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import {
  addTemplateAction,
  deleteTemplateAction,
  saveTemplateAction,
  setDefaultTemplateAction,
  type TemplateResult,
  type TemplateRow,
} from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { controlClass, describedBy, FieldError } from './fields';
import { useReportUnsaved } from './unsaved-guard';

type Notice = { tone: 'status' | 'alert'; text: string } | null;
type Draft = { id: string; name: string; bodyMd: string };

const blank = (): Draft => ({ id: crypto.randomUUID(), name: '', bodyMd: '' });

/**
 * Recap templates: a list to pick from, the editor for the picked one, and
 * "New template". Saved on their own actions, not by the Recap tab's Save.
 * Add and delete show at once and roll back when the server refuses
 * (behaviour rule 2); every answer carries the server's list, so the screen
 * ends in the server's state. A new template's id is made here and kept
 * across retries, so a retry cannot add it twice.
 */
export function Templates({ initial }: { initial: TemplateRow[] }) {
  const t = useTranslations('settings.templates');
  const tCommon = useTranslations('common');
  const [templates, setTemplates] = useState(initial);
  const [selected, setSelected] = useState<string | 'new'>(initial[0]?.id ?? 'new');
  const [draft, setDraft] = useState<Draft>(() => (initial[0] ? { ...initial[0] } : blank()));
  const [errors, setErrors] = useState<Partial<Record<'name' | 'bodyMd', string>>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);
  const deletedRef = useRef(false);

  const isNew = selected === 'new';
  const current = templates.find((tpl) => tpl.id === selected);
  // A draft that differs from its template, or a new one with text in it, is unsaved:
  // the Recap tab is marked and leaving it asks, with the model form's changes.
  const unsaved = isNew
    ? draft.name.trim() !== '' || draft.bodyMd !== ''
    : Boolean(current) && (draft.name.trim() !== current!.name || draft.bodyMd !== current!.bodyMd);
  useReportUnsaved('templates', unsaved);

  const pick = (id: string | 'new') => {
    const tpl = templates.find((x) => x.id === id);
    setSelected(id);
    setDraft(tpl ? { id: tpl.id, name: tpl.name, bodyMd: tpl.bodyMd } : blank());
    setErrors({});
  };

  /** Applies the server's answer; on a refusal, `rollback` restores what the screen showed before. */
  const settle = (result: TemplateResult, rollback: () => void, failed: string) => {
    if (result.ok) {
      setTemplates(result.templates);
      return true;
    }
    rollback();
    if (result.templates) setTemplates(result.templates);
    if (result.errors) setErrors(result.errors);
    setNotice({ tone: 'alert', text: result.errors?.name ?? result.errors?.bodyMd ?? failed });
    return false;
  };

  const add = () => {
    const value = { ...draft, name: draft.name.trim() };
    const before = templates;
    setTemplates([...templates, { ...value, isDefault: templates.length === 0 }]);
    setSelected(value.id);
    setErrors({});
    setNotice(null);
    startTransition(async () => {
      const result = await addTemplateAction(value).catch(() => ({ ok: false }) as TemplateResult);
      const ok = settle(
        result,
        () => {
          setTemplates(before);
          setSelected('new');
          setDraft(value);
        },
        t('addFailed', { name: value.name || '…' }),
      );
      if (ok) setNotice({ tone: 'status', text: t('added', { name: value.name }) });
    });
  };

  const save = () => {
    const value = { ...draft, name: draft.name.trim() };
    const before = templates;
    setTemplates(templates.map((tpl) => (tpl.id === value.id ? { ...tpl, ...value } : tpl)));
    setErrors({});
    setNotice(null);
    startTransition(async () => {
      const result = await saveTemplateAction(value).catch(() => ({ ok: false }) as TemplateResult);
      if (settle(result, () => setTemplates(before), t('saveFailed', { name: value.name })))
        setNotice({ tone: 'status', text: t('saved', { name: value.name }) });
    });
  };

  const makeDefault = () => {
    if (!current) return;
    const before = templates;
    setTemplates(templates.map((tpl) => ({ ...tpl, isDefault: tpl.id === current.id })));
    setNotice(null);
    startTransition(async () => {
      const result = await setDefaultTemplateAction(current.id).catch(
        () => ({ ok: false }) as TemplateResult,
      );
      if (settle(result, () => setTemplates(before), t('saveFailed', { name: current.name })))
        setNotice({ tone: 'status', text: t('nowDefault', { name: current.name }) });
    });
  };

  const remove = () => {
    if (!current) return;
    const gone = current;
    const before = templates;
    const rest = templates.filter((tpl) => tpl.id !== gone.id);
    deletedRef.current = true;
    setConfirming(false);
    setTemplates(rest);
    pick(rest[0]?.id ?? 'new');
    if (rest[0]) setDraft({ ...rest[0] });
    setNotice(null);
    startTransition(async () => {
      const result = await deleteTemplateAction(gone.id).catch(
        () => ({ ok: false }) as TemplateResult,
      );
      const ok = settle(
        result,
        () => {
          setTemplates(before);
          setSelected(gone.id);
          setDraft({ ...gone });
        },
        t('deleteFailed', { name: gone.name }),
      );
      if (ok) setNotice({ tone: 'status', text: t('deleted', { name: gone.name }) });
    });
  };

  // Enter in a template field must not submit the settings form around it.
  const noSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (isNew) add();
      else save();
    }
  };

  return (
    <Dialog open={confirming} onOpenChange={setConfirming}>
      <div className="grid gap-4">
        <div ref={listRef} role="group" aria-label={t('list')} className="flex flex-wrap gap-2">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              aria-pressed={tpl.id === selected}
              onClick={() => pick(tpl.id)}
              className={cn(
                'inline-flex min-h-9 max-w-full items-center gap-2 rounded-pill border border-border bg-card px-3.5 py-[7px] text-sm transition-[background-color,color,border-color] hover:bg-secondary max-shell:min-h-11',
                tpl.id === selected &&
                  'border-accent-line-control bg-accent-tint text-accent-foreground hover:bg-accent-tint',
              )}
            >
              <span className="truncate" title={tpl.name}>
                {tpl.name}
              </span>
              {tpl.isDefault && (
                <span className="text-xs text-muted-foreground">{t('default')}</span>
              )}
            </button>
          ))}
          <Button
            variant={isNew ? 'secondary' : 'quiet'}
            aria-pressed={isNew}
            onClick={() => pick('new')}
            className="min-h-9 rounded-pill max-shell:min-h-11"
          >
            <Plus aria-hidden="true" />
            {t('new')}
          </Button>
        </div>
        {templates.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}

        <div className="grid gap-4" onKeyDown={noSubmit}>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor="template-name" className="font-[550]">
              {t('name')}
            </label>
            <input
              id="template-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy('template-name', false, errors.name)}
              className={controlClass}
            />
            <FieldError id="template-name" error={errors.name} />
          </div>
          <div className="grid gap-1.5 text-sm">
            <label htmlFor="template-body" className="font-[550]">
              {t('body')}
            </label>
            <textarea
              id="template-body"
              rows={8}
              value={draft.bodyMd}
              onChange={(e) => setDraft({ ...draft, bodyMd: e.target.value })}
              aria-invalid={errors.bodyMd ? true : undefined}
              aria-describedby={describedBy('template-body', false, errors.bodyMd)}
              className={cn(controlClass, 'min-h-24 resize-y font-mono text-[13px]')}
            />
            <FieldError id="template-body" error={errors.bodyMd} />
          </div>
          <div className="flex flex-wrap gap-2">
            {isNew ? (
              <Button onClick={add} aria-busy={pending || undefined}>
                <Plus aria-hidden="true" />
                {t('add')}
              </Button>
            ) : (
              <>
                <Button onClick={save} aria-busy={pending || undefined}>
                  {t('save')}
                </Button>
                {current && !current.isDefault && (
                  <Button onClick={makeDefault}>{t('setDefault')}</Button>
                )}
                <DialogTrigger asChild>
                  <Button variant="quiet" className="text-destructive">
                    <Trash2 aria-hidden="true" />
                    {t('delete')}
                  </Button>
                </DialogTrigger>
              </>
            )}
          </div>
          <p
            role={notice?.tone ?? 'status'}
            className={cn(
              'text-sm',
              notice?.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {notice?.text}
          </p>
        </div>

        <DialogContent
          closeLabel={tCommon('close')}
          onCloseAutoFocus={(e) => {
            // After a delete the opener is gone; focus moves to the list instead.
            if (deletedRef.current) {
              e.preventDefault();
              deletedRef.current = false;
              listRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
            }
          }}
        >
          <DialogTitle>{t('deleteTitle')}</DialogTitle>
          <DialogDescription>{t('deleteBody', { name: current?.name ?? '' })}</DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{tCommon('cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" onClick={remove}>
              <Trash2 aria-hidden="true" />
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </div>
    </Dialog>
  );
}
