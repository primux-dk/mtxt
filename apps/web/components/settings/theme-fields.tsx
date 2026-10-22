'use client';

import { Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { formatRatio, HEX, themeFailures } from '@/lib/theme/contrast';
import { describedBy, FieldError, helpId } from './fields';

/**
 * The Theme setting: two native colour inputs with the hex beside them, the
 * live contrast status from the same maths the server refuses with, and the
 * preview row of derived states. The preview carries data-theme-preview so
 * tokens.css recomputes the derived tokens from the values picked here.
 */
export function ThemeFields({
  accent,
  primary,
  onAccent,
  onPrimary,
  errors,
}: {
  accent: string;
  primary: string;
  onAccent: (value: string) => void;
  onPrimary: (value: string) => void;
  errors: { themeAccent?: string; themePrimary?: string };
}) {
  const t = useTranslations('settings');
  const tLib = useTranslations('library');
  const tAll = useTranslations();
  const format = useFormatter();
  const valid = HEX.test(accent) && HEX.test(primary);
  const worst = valid ? themeFailures(accent, primary)[0] : undefined;

  const colour = (
    id: 'themeAccent' | 'themePrimary',
    label: string,
    help: string,
    value: string,
    onChange: (value: string) => void,
  ) => (
    <div className="grid content-start gap-1.5 text-sm">
      <label htmlFor={id} className="font-[550]">
        {label}
      </label>
      <span className="flex items-center gap-3">
        <input
          id={id}
          name={id}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={errors[id] ? true : undefined}
          aria-describedby={describedBy(id, true, errors[id])}
          className="h-10 w-12 min-w-12 cursor-pointer rounded-control border border-input bg-card p-1 aria-invalid:border-destructive"
        />
        <span className="font-mono text-[13px] tabular-nums">{value}</span>
      </span>
      <small id={helpId(id)} className="text-xs text-muted-foreground">
        {help}
      </small>
      <FieldError id={id} error={errors[id]} />
    </div>
  );

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
        {colour('themeAccent', t('theme.accent'), t('theme.accentHelp'), accent, onAccent)}
        {colour('themePrimary', t('theme.primary'), t('theme.primaryHelp'), primary, onPrimary)}
      </div>
      <p className="text-xs text-muted-foreground">{t('theme.note')}</p>
      <p
        role="status"
        className={worst ? 'text-xs font-[550] text-destructive' : 'text-xs text-muted-foreground'}
      >
        {worst
          ? t('theme.fails', {
              pair: t(`theme.pair.${worst.pair}`),
              ratio: formatRatio(worst.ratio),
              mode: t(`theme.mode.${worst.mode}`),
            })
          : t('theme.passes')}
      </p>
      <div
        role="group"
        aria-label={t('theme.preview')}
        data-theme-preview
        inert
        style={
          valid
            ? ({ '--theme-accent': accent, '--theme-primary': primary } as React.CSSProperties)
            : undefined
        }
        className="flex flex-wrap items-center gap-3 rounded-card border border-line-subtle bg-background p-4"
      >
        <span aria-hidden="true" className="mr-1 text-xs text-muted-foreground">
          {t('theme.preview')}
        </span>
        <span className="inline-flex min-h-10 items-center rounded-pill border border-primary bg-primary px-4 text-sm font-[550] text-primary-foreground">
          {tLib('newMeeting')}
        </span>
        <span className="inline-flex min-h-9 items-center rounded-pill border border-accent-line-control bg-accent-tint px-3.5 text-sm text-accent-foreground">
          {tLib('filter.all')}
          <span className="ml-2 text-muted-foreground">{format.number(12)}</span>
        </span>
        <span className="inline-flex min-h-9 items-center rounded-pill border border-border bg-card px-3.5 text-sm">
          {tLib('filter.thisWeek')}
          <span className="ml-2 text-muted-foreground">{format.number(5)}</span>
        </span>
        <span className="inline-flex h-5 w-8 items-center rounded-full border border-accent-strong bg-accent-strong p-0.5">
          <span className="ml-auto block size-3.5 rounded-full border border-border bg-card" />
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-accent-foreground">
          <span className="size-1.5 rounded-full bg-current" />
          {tAll('status.ready')}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-pill border border-accent-line bg-accent-tint px-2.5 py-0.5 text-xs text-accent-foreground">
          <Users aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          {tAll('visibility.shared')}
        </span>
      </div>
    </div>
  );
}
