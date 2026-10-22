'use client';

import { TriangleAlert, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  checkFile,
  savedUploads,
  uploadFile,
  UploadError,
  type SavedUpload,
  type UploadProgress,
} from '@/lib/recordings-client';

type Problem =
  | { kind: 'file'; key: 'notAudio' | 'tooLarge' | 'empty' }
  | {
      kind: 'upload';
      key: 'network' | 'mismatch' | 'disabled' | 'tooLarge' | 'rejected';
      code: string;
    };

const titleFromFile = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim() || name;

/**
 * Upload an audio file (behaviour.md rules 9 and 11): a drop zone and a real
 * file input, progress per chunk, and Resume when the same file was partly
 * uploaded before a reload. Errors say what to do next and keep the file.
 * With `meetingId` it adds a recording to that meeting instead of creating one.
 */
export function UploadDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  meetingId,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  meetingId?: string;
}) {
  const t = useTranslations('upload');
  const common = useTranslations('common');
  const router = useRouter();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean) => {
    if (!value && busy) return;
    (onOpenChange ?? setOwnOpen)(value);
  };

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState<SavedUpload | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ids = { file: useId(), title: useId(), problem: useId() };

  // An upload in flight warns before the page goes away (packet decision).
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const reset = () => {
    setFile(null);
    setTitle('');
    setSaved(null);
    setProgress(null);
    setProblem(null);
    setDone(false);
  };

  const choose = (chosen: File | undefined) => {
    if (!chosen || busy) return;
    reset();
    const bad = checkFile(chosen);
    if (bad) {
      setProblem({ kind: 'file', key: bad });
      return;
    }
    setFile(chosen);
    setTitle(titleFromFile(chosen.name));
    setSaved(savedUploads.get(chosen));
  };

  const start = async (resume?: SavedUpload) => {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      const target = meetingId
        ? { meetingId }
        : { title: title.trim() || titleFromFile(file.name) };
      const result = await uploadFile(file, target, setProgress, resume);
      setDone(true);
      router.push(`/meetings/${result.meetingId}`);
      if (meetingId) router.refresh();
      (onOpenChange ?? setOwnOpen)(false);
      reset();
    } catch (error) {
      const e = error instanceof UploadError ? error : new UploadError('network', 'unknown');
      setProblem({ kind: 'upload', key: e.kind, code: e.code });
      // A mismatch removed the server's copy; the next try starts over.
      setSaved(e.kind === 'mismatch' ? null : savedUploads.get(file));
    } finally {
      setBusy(false);
    }
  };

  const percent =
    progress && (progress.phase === 'hashing' || progress.phase === 'uploading')
      ? Math.round((progress.done / Math.max(1, progress.total)) * 100)
      : null;
  const status = done
    ? t('progress.done')
    : !progress
      ? null
      : progress.phase === 'hashing'
        ? t('progress.hashing', { percent: percent ?? 0 })
        : progress.phase === 'uploading'
          ? t('progress.uploading', { done: progress.done, total: progress.total })
          : progress.phase === 'verifying'
            ? t('progress.verifying')
            : t('error.network');

  const message =
    problem &&
    (problem.kind === 'file'
      ? t(`error.${problem.key}`)
      : problem.key === 'rejected'
        ? t('error.rejected', { code: problem.code })
        : t(`error.${problem.key}`));

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) reset();
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        closeLabel={common('close')}
        onInteractOutside={(event) => busy && event.preventDefault()}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
      >
        <div className="grid gap-2">
          <DialogTitle>{meetingId ? t('titleExisting') : t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </div>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(event.dataTransfer.files[0]);
          }}
          data-testid="drop-zone"
          className={cn(
            'grid place-items-center gap-3 rounded-card border border-dashed border-input bg-background px-4 py-8 text-center transition-[background-color,border-color]',
            dragging && 'border-accent-strong bg-accent-tint',
          )}
        >
          <Upload aria-hidden="true" className="size-8 text-accent-strong" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">{t('drop')}</p>
          <input
            ref={input}
            id={ids.file}
            type="file"
            accept="audio/*,.m4a,.opus,.webm"
            className="sr-only"
            // The button below is the control; the input only holds the file.
            tabIndex={-1}
            aria-label={t('field')}
            aria-describedby={problem ? ids.problem : undefined}
            onChange={(event) => choose(event.target.files?.[0])}
            disabled={busy}
          />
          <Button onClick={() => input.current?.click()} disabled={busy}>
            {t('choose')}
          </Button>
          {file && (
            <p className="max-w-full text-sm break-words" data-testid="chosen-file">
              {file.name}
            </p>
          )}
        </div>

        {file && !meetingId && (
          <div className="grid gap-1.5 text-sm">
            <label htmlFor={ids.title} className="font-[550]">
              {t('meetingTitle')}
            </label>
            <Input
              id={ids.title}
              value={title}
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
            />
          </div>
        )}

        {message && (
          <p
            id={ids.problem}
            role="alert"
            className="flex items-start gap-2 text-sm text-destructive"
          >
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.5}
            />
            {message}
          </p>
        )}

        {(busy || done) && (
          <div className="grid gap-2" aria-live="polite">
            <progress
              aria-label={t('progress.label')}
              max={100}
              value={percent ?? undefined}
              className="h-2 w-full accent-accent-strong"
            />
            <p className="text-xs text-muted-foreground tabular-nums">{status}</p>
          </div>
        )}

        {saved && file && !busy && (
          <div className="grid gap-1 rounded-control border border-accent-line bg-accent-tint-soft p-3 text-sm">
            <p className="font-[550]">{t('resume.title')}</p>
            <p className="text-muted-foreground">
              {t('resume.body', {
                done: saved.chunks_done.length,
                total: Math.ceil(file.size / (8 * 1024 * 1024)),
              })}
            </p>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {saved && file && !busy ? (
            <>
              <Button
                onClick={() => {
                  savedUploads.clear(file);
                  setSaved(null);
                  void start();
                }}
              >
                {t('resume.restart')}
              </Button>
              <Button variant="primary" onClick={() => void start(saved)}>
                {problem ? t('retry') : t('resume.action')}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={!file || busy || done}
              aria-busy={busy}
              onClick={() => void start()}
            >
              {problem?.kind === 'upload' ? t('retry') : t('start')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
