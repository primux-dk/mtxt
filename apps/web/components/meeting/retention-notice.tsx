'use client';

import { Pin, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { RetentionNotice as Notice } from '@mtxt/adapters';
import { LocalTime } from '@/components/local-time';
import { useKeep } from './keep-state';

/**
 * The retention announcement in the meeting header (behaviour.md rule 3):
 * "Will be deleted on 30 November 2026 · Keep", from 7 days before a
 * deadline (lib: retentionNotice). Keep here is the same optimistic flag as
 * the toggle in the actions row; while kept, the notice says so instead,
 * so a kept meeting inside the window still says why nothing will happen.
 * Readers see the date, without Keep.
 */
export function RetentionNotice({ notice, owner }: { notice: Notice | null; owner: boolean }) {
  const t = useTranslations('retention.notice');
  const { keep, set } = useKeep();
  if (!notice) return null;
  if (keep) {
    return (
      <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Pin aria-hidden="true" className="size-4" strokeWidth={1.5} />
        {t('kept')}
      </p>
    );
  }
  const date = () => (
    <LocalTime
      date={new Date(notice.at)}
      options={{ dateStyle: 'long' }}
      className="tabular-nums"
    />
  );
  return (
    <p
      role="status"
      data-testid="retention-notice"
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive"
    >
      <Trash2 aria-hidden="true" className="size-4" strokeWidth={1.5} />
      <span>
        {notice.overdue ? t(`tonight.${notice.kind}`) : t.rich(`on.${notice.kind}`, { date })}
      </span>
      {owner && (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => set(true)}
            className="min-h-10 rounded-control px-1 font-[550] text-foreground underline underline-offset-4 hover:text-accent-strong max-shell:min-h-11"
          >
            {t('keep')}
          </button>
        </>
      )}
    </p>
  );
}
