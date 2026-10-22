'use client';

import { Pin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { useKeep } from './keep-state';

/** The keep flag in the actions row. The state and its rollback live in KeepProvider. */
export function KeepToggle() {
  const t = useTranslations('meeting.keep');
  const { keep, failed, set } = useKeep();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        aria-pressed={keep}
        aria-label={t('label')}
        className={cn(
          keep &&
            'border-accent-line-control bg-accent-tint text-accent-foreground hover:bg-accent-tint',
          'max-shell:px-2.5 max-shell:text-xs',
        )}
        onClick={() => set(!keep)}
      >
        <Pin aria-hidden="true" />
        {t('text')}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {t('failed')}
        </span>
      )}
    </span>
  );
}
