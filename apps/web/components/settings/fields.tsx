'use client';

import { TriangleAlert } from 'lucide-react';
import { cn } from 'cn';

/** The control look from the mockups' `.field input`, for native select and textarea. */
export const controlClass =
  'min-h-10 w-full min-w-0 rounded-control border border-input bg-card px-3 py-2 text-sm leading-[1.5] transition-[border-color] aria-invalid:border-destructive max-shell:min-h-11';

/**
 * Figure 07's row: the label column on the left, the controls on the right;
 * stacked on a phone. The first on a tab has no rule, since the tab strip has one.
 */
export function Section({
  id,
  heading,
  help,
  children,
}: {
  id: string;
  heading: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="grid grid-cols-[204px_minmax(0,1fr)] gap-8 border-t border-border py-6 first-of-type:border-t-0 first-of-type:pt-0 max-shell:grid-cols-1 max-shell:gap-4"
    >
      <div>
        <h2 id={`${id}-heading`} className="text-base">
          {heading}
        </h2>
        {help && <p className="mt-2 text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export const errorId = (id: string) => `${id}-error`;
export const helpId = (id: string) => `${id}-help`;

/** Ids for a control's aria-describedby: its help and, when there is one, its error. */
export const describedBy = (id: string, help: boolean, error?: string) =>
  [help && helpId(id), error && errorId(id)].filter(Boolean).join(' ') || undefined;

/**
 * A persistent label above, help below, and the error at the field in the
 * warning colour with an icon (guidelines §6, behaviour rule 9).
 */
export function Field({
  id,
  label,
  help,
  error,
  extra,
  className,
  children,
}: {
  id: string;
  label: string;
  help?: React.ReactNode;
  error?: string;
  /** Beside the label: for example the "Set" status of a secret. */
  extra?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5 text-sm', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="font-[550]">
          {label}
        </label>
        {extra}
      </div>
      {children}
      {help && (
        <small id={helpId(id)} className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {help}
        </small>
      )}
      <FieldError id={id} error={error} />
    </div>
  );
}

export function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <small id={errorId(id)} className="flex gap-1.5 text-xs text-destructive">
      <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0" strokeWidth={1.5} />
      <span>{error}</span>
    </small>
  );
}

/**
 * A toggle: a real button with aria-pressed and a visible text label beside
 * it. On is the accent fill. The hidden input carries the value in the form.
 */
export function Toggle({
  id,
  name,
  label,
  help,
  pressed,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  help?: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p id={`${id}-label`} className="text-sm font-[550]">
          {label}
        </p>
        {help && (
          <small id={helpId(id)} className="text-xs text-muted-foreground">
            {help}
          </small>
        )}
      </div>
      <button
        id={id}
        type="button"
        aria-pressed={pressed}
        aria-labelledby={`${id}-label`}
        aria-describedby={help ? helpId(id) : undefined}
        onClick={() => onChange(!pressed)}
        className="inline-flex h-5 w-8 min-w-8 items-center rounded-full border border-input bg-muted p-0.5 transition-[background-color,border-color] aria-pressed:border-accent-strong aria-pressed:bg-accent-strong max-shell:my-3"
      >
        <span
          aria-hidden="true"
          className={cn(
            'block size-3.5 rounded-full border border-border bg-card',
            pressed && 'ml-auto',
          )}
        />
      </button>
      {pressed && <input type="hidden" name={name} value="on" />}
    </div>
  );
}

/** "Set" or "Not set" beside a secret's label. Words, not colour alone. */
export function SecretStatus({
  set,
  labels,
}: {
  set: boolean;
  labels: { set: string; notSet: string };
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-pill border px-2 py-px text-xs',
        set
          ? 'border-accent-line bg-accent-tint text-accent-foreground'
          : 'border-border text-muted-foreground',
      )}
    >
      {set ? labels.set : labels.notSet}
    </span>
  );
}
