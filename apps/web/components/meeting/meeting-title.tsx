'use client';

import { Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { renameMeeting } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The meeting title. The owner renames it in place: the new title shows at
 * once and the server saves behind; if the server refuses, the last saved
 * title comes back with a message (behaviour.md rule 2).
 */
export function MeetingTitle({
  meetingId,
  title,
  canRename,
}: {
  meetingId: string;
  title: string;
  canRename: boolean;
}) {
  const t = useTranslations('meeting.rename');
  const common = useTranslations('common');
  const router = useRouter();
  const [saved, setSaved] = useState(title);
  const [shown, setShown] = useState(title);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<'required' | 'failed' | null>(null);
  const [, startTransition] = useTransition();
  const button = useRef<HTMLButtonElement>(null);
  const ids = { field: useId(), error: useId() };

  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => button.current?.focus());
  };

  const save = () => {
    const next = draft.trim();
    if (!next) {
      setError('required');
      return;
    }
    setError(null);
    close();
    if (next === saved) return;
    setShown(next);
    startTransition(async () => {
      const result = await safely(() => renameMeeting(meetingId, next));
      if (result.ok) {
        setSaved(next);
        router.refresh();
      } else {
        setShown(saved);
        setDraft(saved);
        setError('failed');
      }
    });
  };

  if (editing) {
    return (
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor={ids.field} className="text-sm font-[550]">
          {t('field')}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={ids.field}
            autoFocus
            value={draft}
            maxLength={500}
            aria-invalid={error === 'required'}
            aria-describedby={error ? ids.error : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(shown);
                setError(null);
                close();
              }
            }}
            className="min-w-0 flex-1 text-base"
          />
          <Button type="submit">{t('save')}</Button>
          <Button
            variant="quiet"
            onClick={() => {
              setDraft(shown);
              setError(null);
              close();
            }}
          >
            {common('cancel')}
          </Button>
        </div>
        {error === 'required' && (
          <p id={ids.error} className="text-sm text-destructive">
            {t('required')}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-start gap-2">
        <h1 className="min-w-0 text-[30px] leading-[1.15] tracking-[-0.04em] break-words max-shell:text-2xl">
          {shown}
        </h1>
        {canRename && (
          <Button
            ref={button}
            variant="quiet"
            size="icon"
            aria-label={t('label')}
            title={t('button')}
            onClick={() => {
              setDraft(shown);
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
          </Button>
        )}
      </div>
      {error === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {t('failed')}
        </p>
      )}
    </div>
  );
}
