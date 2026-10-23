'use client';

import { RotateCw, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { retryDeliveryAction, sendTestEventAction } from '@/app/(app)/settings/webhook-actions';
import { Button } from '@/components/ui/button';

/** How long the log waits before it reads the attempt's result. */
const RESULT_AFTER_MS = 1500;

/**
 * Retry now on one delivery. Shows "Queued" at once and goes back to the
 * button with the reason when the server refuses (behaviour rule 2); the
 * row reads the attempt's result from the server a moment later. The log
 * keys this on the server's attempt count, so "Queued" lasts only until
 * that attempt is made. Queueing the same attempt twice sends it once
 * (lib/webhooks/deliver.ts).
 */
export function RetryDelivery({ deliveryId, label }: { deliveryId: string; label: string }) {
  const t = useTranslations('settings.webhooks.logPage');
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'queued' | 'failed'>('idle');
  const [, startTransition] = useTransition();
  if (state === 'queued') {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {t('retried')}
      </span>
    );
  }
  return (
    <span className="grid justify-items-start gap-1">
      <Button
        aria-label={label}
        onClick={() => {
          setState('queued');
          startTransition(async () => {
            const result = await retryDeliveryAction(deliveryId).catch(() => ({ ok: false }));
            if (!result.ok) return setState('failed');
            setTimeout(() => router.refresh(), RESULT_AFTER_MS);
          });
        }}
      >
        <RotateCw aria-hidden="true" />
        {t('retry')}
      </Button>
      {state === 'failed' && (
        <span role="alert" className="text-xs text-destructive">
          {t('retryFailed')}
        </span>
      )}
    </span>
  );
}

/** "Send test event", the log page's one primary action (rule 10); the new row shows after a moment. */
export function SendTest({ endpointId }: { endpointId: string }) {
  const t = useTranslations('settings.webhooks');
  const router = useRouter();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-grid justify-items-start gap-1">
      <Button
        variant="primary"
        aria-busy={pending || undefined}
        onClick={() =>
          startTransition(async () => {
            const result = await sendTestEventAction(endpointId).catch(() => ({
              ok: false as const,
              message: t('testFailed'),
            }));
            setNote(
              result.ok
                ? { ok: true, text: t('testQueuedHere') }
                : { ok: false, text: result.message },
            );
            if (result.ok) setTimeout(() => router.refresh(), RESULT_AFTER_MS);
          })
        }
      >
        <Send aria-hidden="true" />
        {t('test')}
      </Button>
      <span
        role={note && !note.ok ? 'alert' : 'status'}
        className={note && !note.ok ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
      >
        {note?.text}
      </span>
    </span>
  );
}
