'use client';

import { MicOff, Square, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { formatClock } from '@/components/meetings/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadButton } from '@/components/upload/new-meeting-menu';
import { recorderSession } from '@/lib/recorder-session';
import { LeaveGuard } from './leave-guard';

type Problem = 'denied' | 'noMic' | 'unsupported';

function supported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * The browser recorder page. The recording itself lives in
 * lib/recorder-session.ts, so it outlives this page: leave and come back
 * and an unconfirmed recording is still here with Retry. Record and Stop
 * are real buttons; the red dot always has the word beside it. Permission
 * denied, no microphone and an unsupported browser are three different
 * states, each with its next step (behaviour.md rule 9).
 */
export function BrowserRecorder({ enabled, canUpload }: { enabled: boolean; canUpload: boolean }) {
  const t = useTranslations('recorder.web');
  const intl = useTranslations('locale')('intl');
  const router = useRouter();
  const ids = { title: useId(), status: useId() };
  const snapshot = useSyncExternalStore(
    recorderSession.subscribe,
    recorderSession.snapshot,
    () => null,
  );
  const [problem, setProblem] = useState<Problem | null>(null);
  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const stopButton = useRef<HTMLButtonElement>(null);
  // A recording confirmed while the reader was elsewhere: shown with a link, not opened.
  const opened = useRef(recorderSession.snapshot()?.phase === 'done');
  const phase = snapshot?.phase ?? null;

  useEffect(() => {
    const stamp = new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeStyle: 'short' });
    setTitle(recorderSession.title() ?? t('titleDefault', { date: stamp.format(new Date()) }));
    if (!supported()) setProblem('unsupported');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The clock ticks only while recording.
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [phase]);

  // Record becomes Stop under the pointer; focus follows it.
  useEffect(() => {
    if (phase === 'recording') stopButton.current?.focus();
  }, [phase]);

  // Confirmed: open the meeting, once.
  useEffect(() => {
    if (phase !== 'done' || !snapshot?.meetingId || opened.current) return;
    opened.current = true;
    const meetingId = snapshot.meetingId;
    recorderSession.clear();
    router.push(`/meetings/${meetingId}`);
  }, [phase, snapshot?.meetingId, router]);

  // Audio the server has not confirmed: warn before the page unloads.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'finishing' && phase !== 'failed') return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const start = async () => {
    if (!supported()) {
      setProblem('unsupported');
      return;
    }
    setProblem(null);
    setStarting(true);
    recorderSession.clear();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const stamp = new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeStyle: 'short' });
      opened.current = false;
      recorderSession.start(
        stream,
        title.trim() || t('titleDefault', { date: stamp.format(new Date()) }),
      );
      setNow(Date.now());
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      setProblem(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'noMic');
    } finally {
      setStarting(false);
    }
  };

  if (!enabled) {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        {t('disabled')}
      </p>
    );
  }

  const elapsed = snapshot
    ? Math.floor(((snapshot.stoppedAt ?? now) - snapshot.startedAt) / 1000)
    : 0;
  const status =
    phase === null
      ? t('status.idle')
      : phase === 'recording'
        ? snapshot!.retrying
          ? t('status.retrying')
          : t('status.uploading', { done: snapshot!.sent })
        : phase === 'finishing'
          ? snapshot!.retrying
            ? t('status.retrying')
            : t('status.finishing')
          : phase === 'done'
            ? t('status.done')
            : '';

  return (
    <div className="grid gap-6 rounded-panel border border-border bg-card p-6 max-shell:p-5">
      <LeaveGuard active={phase === 'recording' || phase === 'finishing' || phase === 'failed'} />
      <div className="grid gap-1.5 text-sm">
        <label htmlFor={ids.title} className="font-[550]">
          {t('meetingTitle')}
        </label>
        <Input
          id={ids.title}
          value={title}
          maxLength={500}
          onChange={(event) => {
            setTitle(event.target.value);
            recorderSession.setTitle(event.target.value);
          }}
          disabled={phase === 'finishing' || phase === 'done'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-5">
        {phase === 'recording' ? (
          <Button
            ref={stopButton}
            variant="primary"
            className="min-h-14 rounded-full px-6 text-base"
            onClick={() => recorderSession.stop()}
          >
            <Square aria-hidden="true" className="size-4 fill-current" />
            {t('stop')}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="min-h-14 rounded-full px-6 text-base"
            onClick={() => void start()}
            disabled={starting || (phase !== null && phase !== 'done') || problem === 'unsupported'}
            aria-busy={starting}
          >
            <span
              aria-hidden="true"
              className="inline-block size-3.5 rounded-full bg-destructive"
            />
            {t('record')}
          </Button>
        )}
        <div className="grid gap-1">
          <time
            aria-label={t('elapsed')}
            className="text-2xl leading-[1.2] font-[550] tracking-[-0.035em] tabular-nums"
            data-testid="elapsed"
          >
            {formatClock(elapsed)}
          </time>
          {phase === 'recording' && (
            <span
              className="inline-flex items-center gap-2 text-xs text-destructive"
              data-testid="recording-indicator"
            >
              <span
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full bg-destructive"
              />
              {t('recording')}
            </span>
          )}
        </div>
      </div>

      <label className="grid grid-cols-[auto_1fr] items-center gap-3 text-xs text-muted-foreground">
        <span>{t('level')}</span>
        <meter min={0} max={100} value={snapshot?.level ?? 0} className="level-meter h-2 w-full" />
      </label>

      <p id={ids.status} aria-live="polite" className="text-sm text-muted-foreground">
        {status}
        {phase === 'done' && snapshot?.meetingId && (
          <>
            {' '}
            <Link href={`/meetings/${snapshot.meetingId}`} className="underline underline-offset-4">
              {t('openMeeting')}
            </Link>
          </>
        )}
      </p>

      {(problem || phase === 'failed') && (
        <div
          role="alert"
          className="grid gap-3 rounded-control border border-border bg-background p-4"
        >
          <p className="flex items-start gap-2 font-[550] text-destructive">
            {phase === 'failed' ? (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0"
                strokeWidth={1.5}
              />
            ) : (
              <MicOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} />
            )}
            {t(`${phase === 'failed' ? 'failed' : problem!}.title`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(`${phase === 'failed' ? 'failed' : problem!}.body`)}
          </p>
          <div className="flex flex-wrap gap-2">
            {phase === 'failed' ? (
              <Button onClick={() => recorderSession.retry()}>{t('tryAgain')}</Button>
            ) : (
              <>
                {problem !== 'unsupported' && (
                  <Button onClick={() => void start()}>{t('tryAgain')}</Button>
                )}
                {canUpload && <UploadButton label={t('uploadInstead')} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
