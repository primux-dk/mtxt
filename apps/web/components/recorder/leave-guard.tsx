'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { recorderSession } from '@/lib/recorder-session';

/**
 * While the recorder holds audio the server has not confirmed, a click on
 * any link inside the app asks first. Leaving keeps the recording in
 * lib/recorder-session.ts: a recording in progress is stopped and its
 * upload carries on, and New meeting shows it again with Retry.
 * beforeunload covers a full page unload; this covers Next navigation,
 * which never unloads the page.
 */
export function LeaveGuard({ active }: { active: boolean }) {
  const t = useTranslations('recorder.web.leave');
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.(
        'a[href]',
      ) as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      // Captured at the document, before Next's own click handler on the link.
      event.preventDefault();
      event.stopPropagation();
      setTarget(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', intercept, true);
    return () => document.removeEventListener('click', intercept, true);
  }, [active]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent closeLabel={t('stay')}>
        <div className="grid gap-2">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('body')}</DialogDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <DialogClose asChild>
            <Button variant="primary">{t('stay')}</Button>
          </DialogClose>
          <Button
            onClick={() => {
              const href = target!;
              setTarget(null);
              recorderSession.stop();
              router.push(href);
            }}
          >
            {t('leave')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
