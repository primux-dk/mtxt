'use client';

import { Pin } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { setKeep } from '@/app/(app)/meetings/actions';
import { Button } from '@/components/ui/button';
import { safely } from '@/lib/safe-action';

/**
 * The keep flag, optimistic (behaviour.md rule 2). One request is in flight
 * at a time; clicks meanwhile only change the wanted value, and when the
 * request returns the latest wanted value is sent if it differs. On a
 * failure the button goes back to the last value the server acknowledged.
 */
export function KeepToggle({ meetingId, keep }: { meetingId: string; keep: boolean }) {
  const t = useTranslations('meeting.keep');
  const [shown, setShown] = useState(keep);
  const [failed, setFailed] = useState(false);
  const acked = useRef(keep);
  const wanted = useRef(keep);
  const sending = useRef(false);

  const flush = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (wanted.current !== acked.current) {
        const value = wanted.current;
        const result = await safely(() => setKeep(meetingId, value));
        if (!result.ok) {
          wanted.current = acked.current;
          setShown(acked.current);
          setFailed(true);
          return;
        }
        acked.current = value;
      }
    } finally {
      sending.current = false;
    }
  };

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
          wanted.current = next;
          void flush();
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
