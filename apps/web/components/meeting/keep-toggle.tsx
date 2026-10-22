'use client';

import { Pin } from 'lucide-react';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { setKeep } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';

/** The keep flag: a pressed-state button, optimistic, rolled back if the server refuses (rule 2). */
export function KeepToggle({ meetingId, keep }: { meetingId: string; keep: boolean }) {
  const t = useTranslations('meeting.keep');
  const [saved, setSaved] = useState(keep);
  const [shown, setShown] = useState(keep);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        aria-pressed={shown}
        aria-label={t('label')}
        className={cn(
          shown &&
            'border-accent-line-control bg-accent-tint text-accent-foreground hover:bg-accent-tint',
          'max-shell:px-2.5 max-shell:text-xs',
        )}
        onClick={() => {
          const next = !shown;
          setShown(next);
          setFailed(false);
          startTransition(async () => {
            const result = await safely(() => setKeep(meetingId, next));
            if (result.ok) setSaved(next);
            else {
              setShown(saved);
              setFailed(true);
            }
          });
        }}
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
