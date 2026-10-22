'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { retryTranscription, setPrimaryRecording } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';

/** "Try again" on a failed transcription: queues it again, once. */
export function RetryTranscription({
  meetingId,
  recordingId,
  label,
  failedLabel,
}: {
  meetingId: string;
  recordingId: string;
  label: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        aria-busy={pending}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await safely(() => retryTranscription(meetingId, recordingId));
            setFailed(!result.ok);
            if (result.ok) router.refresh();
          })
        }
      >
        <RotateCw aria-hidden="true" />
        {label}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {failedLabel}
        </span>
      )}
    </>
  );
}

/** "Make primary" on a confirmed recording that is not the primary one. */
export function MakePrimary({
  meetingId,
  recordingId,
  label,
  ariaLabel,
  failedLabel,
}: {
  meetingId: string;
  recordingId: string;
  label: string;
  ariaLabel: string;
  failedLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="quiet"
        aria-label={ariaLabel}
        aria-busy={pending}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await safely(() => setPrimaryRecording(meetingId, recordingId));
            setFailed(!result.ok);
            if (result.ok) router.refresh();
          })
        }
      >
        {label}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {failedLabel}
        </span>
      )}
    </span>
  );
}
