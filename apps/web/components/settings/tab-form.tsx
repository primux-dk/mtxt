'use client';

import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { saveSettingsAction, type SaveResult } from '@/app/(app)/settings/actions';
import { Button } from '@/components/ui/button';
import { TAB_FIELDS, type FormTab } from '@/lib/settings/tabs';
import type { Field as FieldName } from '@/lib/settings/validate';
import { controlClass, describedBy } from './fields';
import { useReportUnsaved } from './unsaved-guard';

export type FieldErrors = Partial<Record<FieldName, string>>;

/** The control each field's summary link moves focus to. */
const fieldId = (field: FieldName) => (field === 'recordingSources' ? 'source-desktop' : field);

const secretFields = (form: HTMLFormElement) => [
  ...form.querySelectorAll<HTMLInputElement>('input[type=password][name]'),
];

/**
 * What the form's fields hold, to tell a change from the saved state. With
 * `blankSecrets`, a secret counts as empty: that is how it reads once saved.
 */
function snapshot(form: HTMLFormElement, blankSecrets = false) {
  const secrets = new Set(secretFields(form).map((input) => input.name));
  return JSON.stringify(
    [...new FormData(form).entries()].map(([k, v]) => [
      k,
      blankSecrets && secrets.has(k) ? '' : typeof v === 'string' ? v : v.name,
    ]),
  );
}

/** Props for a native select or textarea: id, name, the invalid state and its descriptions. */
export const controlProps = (errors: FieldErrors, field: FieldName, help = false) => ({
  id: field,
  name: field,
  'aria-invalid': errors[field] ? true : undefined,
  'aria-describedby': describedBy(field, help, errors[field]),
  className: controlClass,
});

export interface TabFormState {
  errors: FieldErrors;
  /** Call after a change made outside a typing event, such as a CSV import. */
  changed: () => void;
}

/**
 * One settings tab's form: its own fields, its own "Save" primary at the
 * bottom, and on a failed save an error summary with links to only its own
 * fields (behaviour rule 9). What was typed stays, because the form is never
 * reset. While it differs from the saved state, the footer says so and the
 * tab strip marks the tab and asks before leaving it.
 */
export function TabForm<T extends FormTab>({
  tab,
  labels,
  children,
}: {
  tab: T;
  /** The label each field has in the error summary. */
  labels: Record<(typeof TAB_FIELDS)[T][number], string>;
  children: (state: TabFormState) => React.ReactNode;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SaveResult | null>(null);
  const [dirty, setDirty] = useState(false);
  useReportUnsaved(`form:${tab}`, dirty);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const saved = useRef<string | null>(null);

  const errors: FieldErrors = result?.status === 'invalid' ? result.errors : {};
  const errorFields = (TAB_FIELDS[tab] as readonly (typeof TAB_FIELDS)[T][number][]).filter(
    (f) => errors[f],
  );

  const changed = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    // The first look is the saved state; after a save, what was sent is.
    saved.current ??= snapshot(form);
    setDirty(snapshot(form) !== saved.current);
  }, []);

  // Controlled fields change on a render, not always on an input event.
  useEffect(changed);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const element = e.currentTarget;
    const form = new FormData(element);
    // What is sent becomes the saved state; anything typed while it is on its way stays a change.
    const sent = snapshot(element, true);
    const sentSecrets = new Map(secretFields(element).map((input) => [input, input.value]));
    startTransition(async () => {
      const next = await saveSettingsAction(tab, form).catch((): SaveResult => ({
        status: 'error',
        message: t('errors.saveFailed'),
      }));
      setResult(next);
      if (next.status === 'saved') {
        // A saved secret is never shown again; one typed since the save stays.
        for (const [input, value] of sentSecrets) if (input.value === value) input.value = '';
        saved.current = sent;
        changed();
      }
      // The summary takes focus so a keyboard or screen reader user hears what to fix.
      if (next.status !== 'saved') requestAnimationFrame(() => summaryRef.current?.focus());
    });
  };

  return (
    <>
      <div
        ref={summaryRef}
        tabIndex={-1}
        role={result && result.status !== 'saved' ? 'alert' : undefined}
        className="outline-none focus-visible:outline-2"
      >
        {result?.status === 'invalid' && (
          <div className="mb-6 rounded-card border border-destructive p-4 text-sm">
            <p className="flex gap-2 font-[550] text-destructive">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
                strokeWidth={1.5}
              />
              {t('errors.summary', { count: errorFields.length })}
            </p>
            <ul className="mt-2 grid gap-1 pl-6">
              {errorFields.map((field) => (
                <li key={field}>
                  <a
                    href={`#${fieldId(field)}`}
                    className="underline underline-offset-4"
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(fieldId(field));
                      el?.focus();
                      el?.scrollIntoView({ block: 'center' });
                    }}
                  >
                    {labels[field]}
                  </a>
                  : {errors[field]}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result?.status === 'error' && (
          <p className="mb-6 flex gap-2 rounded-card border border-destructive p-4 text-sm text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.5}
            />
            {result.message}
          </p>
        )}
      </div>

      <form
        ref={formRef}
        onSubmit={submit}
        onInput={changed}
        onChange={changed}
        noValidate
        aria-label={t(`tabs.${tab as FormTab}`)}
      >
        {children({ errors, changed })}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
          <p role="status" className="text-xs text-muted-foreground" data-testid="settings-status">
            {dirty ? t('tabs.unsaved') : result?.status === 'saved' ? result.message : t('footer')}
          </p>
          <Button type="submit" variant="primary" aria-busy={pending || undefined}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </>
  );
}
