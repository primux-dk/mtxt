'use client';

import { Archive, ArchiveRestore, Ellipsis, Trash2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { deleteMeeting, setArchived } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UploadDialog } from '@/components/upload/upload-dialog';

/**
 * The owner's overflow menu: upload another recording, Archive or Restore,
 * and Delete. Archive is not delete (behaviour.md rule 3): delete opens a
 * dialog that names what goes before anything goes.
 */
export function MeetingMenu({
  meetingId,
  archived,
  recordings,
  hasRecap,
  canUpload,
}: {
  meetingId: string;
  archived: boolean;
  recordings: number;
  hasRecap: boolean;
  canUpload: boolean;
}) {
  const t = useTranslations('meeting');
  const common = useTranslations('common');
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<'archive' | 'delete' | null>(null);
  const [pending, startTransition] = useTransition();

  const archive = (value: boolean) =>
    startTransition(async () => {
      const result = await safely(() => setArchived(meetingId, value));
      setError(result.ok ? null : 'archive');
      if (result.ok) router.refresh();
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={trigger} size="icon" aria-label={t('more')}>
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canUpload && (
            <DropdownMenuItem onSelect={() => setUploading(true)}>
              <Upload aria-hidden="true" />
              {t('uploadRecording')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => archive(!archived)}>
            {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
            {archived ? t('archive.restore') : t('archive.action')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 aria-hidden="true" />
            {t('delete.action')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error === 'archive' && (
        <span role="alert" className="text-xs text-destructive">
          {t('archive.failed')}
        </span>
      )}

      <UploadDialog
        open={uploading}
        onOpenChange={setUploading}
        meetingId={meetingId}
        returnFocusTo={trigger}
      />

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (pending) return;
          setConfirming(open);
          if (!open) {
            setError(null);
            // Opened from the menu, so focus goes back to the menu's button.
            requestAnimationFrame(() => trigger.current?.focus());
          }
        }}
      >
        <DialogContent closeLabel={common('close')} onCloseAutoFocus={(e) => e.preventDefault()}>
          <div className="grid gap-2">
            <DialogTitle>{t('delete.title')}</DialogTitle>
            <DialogDescription className="text-base text-foreground">
              {t('delete.body', { recordings, recap: hasRecap ? 'yes' : 'no' })}
            </DialogDescription>
            <p className="text-sm text-muted-foreground">{t('delete.note')}</p>
          </div>
          {error === 'delete' && (
            <p role="alert" className="text-sm text-destructive">
              {t('delete.failed')}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button disabled={pending}>{common('cancel')}</Button>
            </DialogClose>
            <Button
              className="border-destructive bg-destructive text-destructive-foreground hover:border-destructive hover:bg-destructive"
              aria-busy={pending}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await safely(() => deleteMeeting(meetingId));
                  if (!result.ok) {
                    setError('delete');
                    return;
                  }
                  router.replace('/meetings');
                  router.refresh();
                })
              }
            >
              <Trash2 aria-hidden="true" />
              {t('delete.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The archived meeting's notice, with Restore for the owner. */
export function ArchivedNotice({ meetingId, owner }: { meetingId: string; owner: boolean }) {
  const t = useTranslations('meeting.archive');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-control border border-accent-line bg-accent-tint-soft px-4 py-3 text-sm"
    >
      <span className="inline-flex items-center gap-2">
        <Archive aria-hidden="true" className="size-4 text-accent-strong" strokeWidth={1.5} />
        {t('notice')}
      </span>
      {owner && (
        <Button
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
          <ArchiveRestore aria-hidden="true" />
          {t('restore')}
        </Button>
      )}
      {failed && (
        <span role="alert" className="w-full text-xs text-destructive">
          {t('failed')}
        </span>
      )}
    </div>
  );
}
