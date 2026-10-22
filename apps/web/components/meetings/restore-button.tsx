'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setArchived } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';

/** Restore from the archive, in the archived view's rows. */
export function RestoreButton({ meetingId, title }: { meetingId: string; title: string }) {
  const t = useTranslations('library.archived');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        aria-label={t('restoreLabel', { title })}
        aria-busy={pending}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await safely(() => setArchived(meetingId, false));
            setFailed(!result.ok);
            if (result.ok) router.refresh();
          })
        }
      >
        {t('restore')}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {t('restoreFailed')}
        </span>
      )}
    </span>
  );
}
