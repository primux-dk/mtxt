'use client';

import { renameMeeting } from '@/app/(app)/meetings/actions';
import { safely } from './safe-action';
import { StreamingUpload } from './recordings-client';

/**
 * The browser recording, kept outside the recorder page. A navigation inside
 * the app unmounts the page but not this module, so an unconfirmed recording
 * (its audio, its recording id, the chunks sent) survives it: coming back to
 * /meetings/new shows the same recording with Retry. Only a confirmation or
 * an explicit discard lets go of it. A full page unload still loses it; the
 * page warns before that.
 */
export type Phase = 'recording' | 'finishing' | 'failed' | 'done';

export interface RecorderSnapshot {
  phase: Phase;
  startedAt: number;
  /** Set when the recording stopped. */
  stoppedAt: number | null;
  level: number;
  sent: number;
  retrying: boolean;
  meetingId: string | null;
}

const PREFERRED = 'audio/webm;codecs=opus';

interface Session {
  recorder: MediaRecorder;
  stream: MediaStream;
  audio: AudioContext | null;
  timers: number[];
  upload: StreamingUpload;
  titleAtStart: string;
  title: string;
  snapshot: RecorderSnapshot;
}

let session: Session | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<RecorderSnapshot>) {
  if (!session) return;
  session.snapshot = { ...session.snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

function releaseMedia(s: Session) {
  s.timers.forEach((id) => clearInterval(id));
  s.timers = [];
  s.stream.getTracks().forEach((track) => track.stop());
  void s.audio?.close().catch(() => {});
  s.audio = null;
}

async function finish(s: Session) {
  update({ phase: 'finishing' });
  try {
    const stoppedAt = s.snapshot.stoppedAt ?? Date.now();
    const { meetingId } = await s.upload.finish(
      Math.round((stoppedAt - s.snapshot.startedAt) / 1000),
    );
    const title = s.title.trim();
    if (title && title !== s.titleAtStart) await safely(() => renameMeeting(meetingId, title));
    update({ phase: 'done', meetingId, retrying: false });
  } catch {
    update({ phase: 'failed', retrying: false });
  }
}

export const recorderSession = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): RecorderSnapshot | null => session?.snapshot ?? null,
  title: () => session?.title ?? null,

  /** True while there is audio the server has not confirmed. */
  hasUnconfirmedAudio: () => Boolean(session && session.snapshot.phase !== 'done'),

  /** Starts recording from a microphone stream the page obtained. */
  start(stream: MediaStream, title: string) {
    const recorder = MediaRecorder.isTypeSupported?.(PREFERRED)
      ? new MediaRecorder(stream, { mimeType: PREFERRED })
      : new MediaRecorder(stream);
    const startedAt = Date.now();
    recorder.start(1000);
    const upload = new StreamingUpload(
      { title, startedAt: new Date(startedAt) },
      recorder.mimeType || 'audio/webm',
      {
        onSent: (n) => update({ sent: n, retrying: false }),
        onRetry: () => update({ retrying: true }),
      },
    );
    upload.start();
    const s: Session = {
      recorder,
      stream,
      audio: null,
      timers: [],
      upload,
      titleAtStart: title,
      title,
      snapshot: {
        phase: 'recording',
        startedAt,
        stoppedAt: null,
        level: 0,
        sent: 0,
        retrying: false,
        meetingId: null,
      },
    };
    session = s;
    recorder.ondataavailable = (event) => upload.add(event.data);
    recorder.onstop = () => {
      releaseMedia(s);
      update({ level: 0, stoppedAt: Date.now() });
      void finish(s);
    };

    // The level meter: an analyser on the same stream, read ten times a second.
    try {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      s.audio = audio;
      s.timers.push(
        window.setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const v of samples) sum += v * v;
          update({ level: Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 300)) });
        }, 100),
      );
    } catch {
      s.audio = null;
    }
    listeners.forEach((listener) => listener());
  },

  stop() {
    if (session && session.recorder.state !== 'inactive') session.recorder.stop();
  },

  /** Sends what the server lacks and completes again. */
  retry() {
    if (session && session.snapshot.phase === 'failed') void finish(session);
  },

  setTitle(title: string) {
    if (session) session.title = title;
  },

  /**
   * Throws the unconfirmed audio away, on the reader's explicit word (the
   * Discard dialog). The server's half-made recording expires with its
   * upload session after 7 days.
   */
  discard() {
    if (!session) return;
    if (session.recorder.state !== 'inactive') {
      session.recorder.onstop = null;
      session.recorder.stop();
    }
    releaseMedia(session);
    session = null;
    listeners.forEach((listener) => listener());
  },

  /** Lets go of a confirmed recording, so the page can start a new one. */
  clear() {
    if (session && session.snapshot.phase === 'done') {
      session = null;
      listeners.forEach((listener) => listener());
    }
  },
};
