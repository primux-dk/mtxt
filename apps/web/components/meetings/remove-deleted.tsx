'use client';

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteMeeting } from '@/app/(app)/meetings/actions';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { safely } from '@/lib/safe-action';

/**
 * Remove, on a library row that retention has emptied. Its audio and
 * transcript are already gone; removing takes the title and date as well,
 * and the dialog says so before it does (behaviour.md rule 3).
 */
export function RemoveDeleted({ meetingId, title }: { meetingId: string; title: string }) {
  const t = useTranslations('retention.remove');
  const common = useTranslations('common');
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <>
      <Button ref={trigger} aria-label={t('label', { title })} onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" />
        {t('action')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setFailed(false);
        }}
      >
        <DialogContent closeLabel={common('close')}>
          <div className="grid gap-2">
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription className="text-base text-foreground">
              {t('body', { title })}
            </DialogDescription>
          </div>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              {t('failed')}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button disabled={pending}>{common('cancel')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              aria-busy={pending}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await safely(() => deleteMeeting(meetingId));
                  if (!result.ok) {
                    setFailed(true);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              <Trash2 aria-hidden="true" />
              {t('confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
