'use client';

import { MicOff, Square, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { renameMeeting } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';
import { formatClock } from '@/components/meetings/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadButton } from '@/components/upload/new-meeting-menu';
import { StreamingUpload } from '@/lib/recordings-client';

type State =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'finishing'
  | 'failed'
  | 'done'
  | 'denied'
  | 'noMic'
  | 'unsupported';

const PREFERRED = 'audio/webm;codecs=opus';

function supported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * The browser recorder: MediaRecorder on the microphone, Opus in WebM where
 * the browser has it. The recording uploads while it is made (StreamingUpload)
 * and stays in the tab until the server confirms it. Record and Stop are real
 * buttons; the red dot always has the word beside it. Permission denied, no
 * microphone and an unsupported browser are three different states, each
 * with its next step (behaviour.md rule 9).
 */
export function BrowserRecorder({ enabled, canUpload }: { enabled: boolean; canUpload: boolean }) {
  const t = useTranslations('recorder.web');
  const intl = useTranslations('locale')('intl');
  const stamp = (date: Date) =>
    new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const router = useRouter();
  const ids = { title: useId(), status: useId() };
  const [state, setState] = useState<State>('idle');
  const [title, setTitle] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [sent, setSent] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    audio: AudioContext | null;
    upload: StreamingUpload;
    startedAt: number;
    titleAtStart: string;
    timers: number[];
  } | null>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTitle(
      t('titleDefault', {
        date: stamp(new Date()),
      }),
    );
    if (!supported()) setState('unsupported');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recording, or holding audio the server has not confirmed: warn before leaving.
  useEffect(() => {
    if (!['recording', 'finishing', 'failed'].includes(state)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);

  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.timers.forEach((id) => clearInterval(id));
      s.stream.getTracks().forEach((track) => track.stop());
      void s.audio?.close();
    },
    [],
  );

  const finish = async () => {
    const s = session.current;
    if (!s) return;
    setState('finishing');
    try {
      const { meetingId } = await s.upload.finish(Math.round((Date.now() - s.startedAt) / 1000));
      const finalTitle = title.trim();
      if (finalTitle && finalTitle !== s.titleAtStart)
        await safely(() => renameMeeting(meetingId, finalTitle));
      setState('done');
      router.push(`/meetings/${meetingId}`);
    } catch {
      setState('failed');
    }
  };

  const start = async () => {
    if (!supported()) {
      setState('unsupported');
      return;
    }
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'noMic');
      return;
    }
    const recorder = MediaRecorder.isTypeSupported?.(PREFERRED)
      ? new MediaRecorder(stream, { mimeType: PREFERRED })
      : new MediaRecorder(stream);

    // The level meter: an analyser on the same stream, read ten times a second.
    let audio: AudioContext | null = null;
    const timers: number[] = [];
    try {
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      timers.push(
        window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) sum += v * v;
          setLevel(Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 300)));
        }, 100),
      );
    } catch {
      audio = null;
    }

    const startedAt = Date.now();
    const titleAtStart =
      title.trim() ||
      t('titleDefault', {
        date: stamp(new Date(startedAt)),
      });
    recorder.start(1000);
    const upload = new StreamingUpload(
      { title: titleAtStart, startedAt: new Date(startedAt) },
      recorder.mimeType || 'audio/webm',
      {
        onSent: (n) => {
          setSent(n);
          setRetrying(false);
        },
        onRetry: () => setRetrying(true),
      },
    );
    upload.start();
    recorder.ondataavailable = (event) => upload.add(event.data);
    recorder.onstop = () => {
      timers.forEach((id) => clearInterval(id));
      stream.getTracks().forEach((track) => track.stop());
      void audio?.close();
      setLevel(0);
      void finish();
    };
    timers.push(
      window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250),
    );
    session.current = { recorder, stream, audio, upload, startedAt, titleAtStart, timers };
    setElapsed(0);
    setState('recording');
    requestAnimationFrame(() => stopButton.current?.focus());
  };

  const stop = () => {
    const s = session.current;
    if (s && s.recorder.state !== 'inactive') s.recorder.stop();
  };

  if (!enabled) {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} />
        {t('disabled')}
      </p>
    );
  }

  const problem =
    state === 'denied' || state === 'noMic' || state === 'unsupported' || state === 'failed'
      ? state
      : null;
  const status =
    state === 'idle' || state === 'starting'
      ? t('status.idle')
      : state === 'recording'
        ? retrying
          ? t('status.retrying')
          : t('status.uploading', { done: sent })
        : state === 'finishing'
          ? retrying
            ? t('status.retrying')
            : t('status.finishing')
          : state === 'done'
            ? t('status.done')
            : '';

  return (
    <div className="grid gap-6 rounded-panel border border-border bg-card p-6 max-shell:p-5">
      <div className="grid gap-1.5 text-sm">
        <label htmlFor={ids.title} className="font-[550]">
          {t('meetingTitle')}
        </label>
        <Input
          id={ids.title}
          value={title}
          maxLength={500}
          onChange={(event) => setTitle(event.target.value)}
          disabled={state === 'finishing' || state === 'done'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-5">
        {state === 'recording' ? (
          <Button
            ref={stopButton}
            variant="primary"
            className="min-h-14 rounded-full px-6 text-base"
            onClick={stop}
          >
            <Square aria-hidden="true" className="size-4 fill-current" />
            {t('stop')}
          </Button>
        ) : (
          <Button
            ref={recordButton}
            variant="primary"
            className="min-h-14 rounded-full px-6 text-base"
            onClick={() => void start()}
            disabled={
              state === 'starting' ||
              state === 'finishing' ||
              state === 'done' ||
              state === 'unsupported' ||
              state === 'failed'
            }
            aria-busy={state === 'starting'}
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
          {state === 'recording' && (
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
        <meter min={0} max={100} value={level} className="h-2 w-full" />
      </label>

      <p id={ids.status} aria-live="polite" className="text-sm text-muted-foreground">
        {status}
      </p>

      {problem && (
        <div
          role="alert"
          className="grid gap-3 rounded-control border border-border bg-background p-4"
        >
          <p className="flex items-start gap-2 font-[550] text-destructive">
            {problem === 'failed' ? (
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0"
                strokeWidth={1.5}
              />
            ) : (
              <MicOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} />
            )}
            {t(`${problem}.title`)}
          </p>
          <p className="text-sm text-muted-foreground">{t(`${problem}.body`)}</p>
          <div className="flex flex-wrap gap-2">
            {problem !== 'unsupported' && (
              <Button onClick={() => void (problem === 'failed' ? finish() : start())}>
                {t('tryAgain')}
              </Button>
            )}
            {problem !== 'failed' && canUpload && <UploadButton label={t('uploadInstead')} />}
          </div>
        </div>
      )}
    </div>
  );
}
