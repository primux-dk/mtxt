'use client';

import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatClock } from '@/components/meetings/format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { recorderSession } from '@/lib/recorder-session';

/**
 * The only way to let go of unconfirmed audio on purpose. The dialog names
 * the recording and says that no other copy exists (behaviour.md rule 3).
 */
export function DiscardRecording({ title, durationS }: { title: string; durationS: number }) {
  const t = useTranslations('recorder.web.discard');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="quiet" className="text-destructive">
          <Trash2 aria-hidden="true" />
          {t('action')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={common('close')}>
        <div className="grid gap-2">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('body', { title: title.trim() || '…', duration: formatClock(durationS) })}
          </DialogDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button>{common('cancel')}</Button>
          </DialogClose>
          <Button
            className="border-destructive bg-destructive text-destructive-foreground hover:border-destructive hover:bg-destructive"
            onClick={() => {
              setOpen(false);
              recorderSession.discard();
            }}
          >
            <Trash2 aria-hidden="true" />
            {t('confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
