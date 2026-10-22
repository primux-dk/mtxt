'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatClock } from '@/components/meetings/format';

const RATES = [1, 1.25, 1.5, 2];

/**
 * The audio player: a native <audio> behind the design's control row, all
 * real controls (play/pause button, range, rate select) so the keyboard
 * works without extra code (behaviour.md rule 11). `start` seeks once the
 * audio is ready, for ?t= links. WebM from a browser often reports no
 * duration, so the recording's own length is the fallback.
 */
export function AudioPlayer({
  src,
  durationS,
  start,
}: {
  src: string;
  durationS: number;
  start?: number;
}) {
  const t = useTranslations('meeting.player');
  const tf = useTranslations('format');
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(start ?? 0);
  const [duration, setDuration] = useState(durationS);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = audio.current;
    if (!el || start === undefined) return;
    const seek = () => {
      // Never past the end the audio itself reports.
      const end = Number.isFinite(el.duration) ? el.duration : start;
      const at = Math.min(start, end);
      el.currentTime = at;
      setTime(at);
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    return () => el.removeEventListener('loadedmetadata', seek);
  }, [start]);

  return (
    <div className="mb-6">
      <div
        role="group"
        aria-label={t('label')}
        className="flex items-center gap-4 rounded-card border border-border bg-card px-4 py-3 max-shell:gap-2 max-shell:px-3"
      >
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onError={() => setFailed(true)}
        />
        <Button
          size="icon"
          className="size-9 rounded-full p-2 max-shell:size-11"
          aria-label={playing ? t('pause') : t('play')}
          disabled={failed}
          onClick={() => {
            const el = audio.current;
            if (!el) return;
            if (el.paused) void el.play().catch(() => setFailed(true));
            else el.pause();
          }}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <time
          className="text-xs whitespace-nowrap tabular-nums max-shell:text-[11px]"
          aria-label={t('current')}
          data-testid="player-time"
        >
          {formatClock(time)}
        </time>
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={1}
          value={Math.min(Math.round(time), Math.max(1, Math.round(duration)))}
          aria-label={t('position')}
          aria-valuetext={formatClock(time)}
          disabled={failed}
          onChange={(e) => {
            const value = Number(e.target.value);
            setTime(value);
            if (audio.current) audio.current.currentTime = value;
          }}
          className="h-1 min-w-5 flex-1 accent-accent-strong"
        />
        <time
          className="text-xs whitespace-nowrap tabular-nums max-shell:hidden"
          aria-label={t('duration')}
        >
          {formatClock(duration)}
        </time>
        <select
          aria-label={t('rate')}
          value={rate}
          onChange={(e) => {
            const value = Number(e.target.value);
            setRate(value);
            if (audio.current) audio.current.playbackRate = value;
          }}
          className="min-h-9 rounded-control bg-transparent text-xs max-shell:min-h-11"
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {tf('rate', { rate: r })}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('unavailable')}
        </p>
      )}
    </div>
  );
}
