'use client';

import { Pencil } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { updateSpeaker } from '@/app/(app)/meetings/speaker-actions';
import { formatClock } from '@/components/meetings/format';
import { Avatar } from '@/components/ui/avatar';
import { seekTo, usePlayhead } from '@/lib/playback';
import { highlight, keytermPattern } from '@/lib/transcript/highlight';
import type { SegmentTuple, SpeakerView } from '@/lib/transcript/queries';
import { SpeakerDialog, type SpeakerDraft } from './speaker-dialog';

/** Segments per block. Blocks far from the viewport render as a spacer (behaviour.md rule 13). */
const BLOCK = 100;
/** A segment's height before it was ever measured. */
const ESTIMATE_PX = 96;
/** The sticky position line's height, so "Showing" counts what is above it. */
const FOOTER_PX = 44;

/** The segment playing at `ms`: the last one that starts at or before it. */
export function segmentAt(segments: readonly SegmentTuple[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]![0] <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

type Speakers = Record<string, SpeakerView>;

/*
  The transcript tab (figure 04, figure 10 on a phone). Every segment shows
  its speaker and a timestamp button that seeks the player and puts `?t=`
  in the address without a navigation (rule 5); the segment under the
  playhead is marked; keyterms are marked where they stand as whole words.
  For the owner a speaker is a button that opens the rename and link
  dialog; the change shows at once on every segment of that speaker and
  rolls back if the server refuses it (rule 2). A reader sees labels.
  A 4-hour meeting has thousands of segments, so only the blocks near the
  viewport are in the page; the rest hold their measured height.
*/
export function TranscriptView({
  meetingId,
  canEdit,
  segments,
  speakers: initialSpeakers,
  keyterms,
  durationS,
  language,
  languageName,
  startAt,
}: {
  meetingId: string;
  canEdit: boolean;
  segments: SegmentTuple[];
  speakers: SpeakerView[];
  keyterms: string[];
  durationS: number;
  /** BCP 47 code of the transcript's language, for `lang` on the text. */
  language: string;
  languageName: string;
  startAt?: number;
}) {
  const t = useTranslations('transcript');
  const ts = useTranslations('speaker');
  const pattern = useMemo(() => keytermPattern(keyterms), [keyterms]);

  const [speakers, setSpeakers] = useState<Speakers>(() =>
    Object.fromEntries(initialSpeakers.map((s) => [s.id, s])),
  );
  const acked = useRef<Speakers>(speakers);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());

  const nameOf = useCallback(
    (s: SpeakerView | undefined) =>
      !s
        ? t('speaker.unnamed', { number: 1 })
        : s.user
          ? s.user.name
          : s.unnamed !== null
            ? t('speaker.unnamed', { number: s.unnamed })
            : s.label,
    [t],
  );

  const close = (id: string) => {
    setEditing(null);
    // Back to the speaker button that opened the dialog (rule 11).
    requestAnimationFrame(() => openers.current.get(id)?.focus());
  };

  const save = async (id: string, draft: SpeakerDraft) => {
    const before = acked.current[id]!;
    const next: SpeakerView = {
      ...before,
      label: draft.label,
      unnamed: null,
      user: draft.user,
    };
    // Typing the "Speaker 3" placeholder back keeps the speaker unnamed.
    if (!draft.user && draft.label === nameOf({ ...before, user: null }))
      next.unnamed = before.unnamed;
    close(id);
    setFailed(false);
    setSpeakers((all) => ({ ...all, [id]: next }));
    const result = await updateSpeaker(meetingId, id, {
      label: next.unnamed !== null ? before.label : draft.label,
      userId: draft.user?.id ?? null,
    }).catch(() => ({ ok: false as const }));
    if (result.ok) {
      acked.current = { ...acked.current, [id]: next };
    } else {
      setSpeakers((all) => ({ ...all, [id]: acked.current[id]! }));
      setFailed(true);
    }
  };

  // Blocks in the page: near the viewport, the one playing and the one a link points at.
  const blockCount = Math.ceil(segments.length / BLOCK);
  const startIndex = startAt === undefined ? -1 : segmentAt(segments, startAt * 1000);
  const [near, setNear] = useState<Set<number>>(
    () => new Set([0, Math.max(0, Math.floor(startIndex / BLOCK))]),
  );
  const heights = useRef(new Map<number, number>());
  const blockRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setNear((current) => {
          const next = new Set(current);
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.block);
            if (current.has(i)) heights.current.set(i, entry.boundingClientRect.height);
            if (entry.isIntersecting) next.add(i);
            else next.delete(i);
          }
          return next.size === current.size && [...next].every((i) => current.has(i))
            ? current
            : next;
        });
      },
      { rootMargin: '1500px 0px' },
    );
    blockRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [blockCount]);

  const playhead = usePlayhead();
  const playing = segmentAt(segments, playhead * 1000 + 1);
  const shown = useMemo(() => {
    const set = new Set(near);
    if (playing >= 0) set.add(Math.floor(playing / BLOCK));
    if (startIndex >= 0) set.add(Math.floor(startIndex / BLOCK));
    return set;
  }, [near, playing, startIndex]);

  // A `?t=` link opens with its segment in view.
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (startIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${startIndex}"]`)
      ?.scrollIntoView({ block: 'center' });
    // Only on the first render: later seeks come from the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Showing 01:03 of 42:06": the last segment whose top is above the position line.
  const [position, setPosition] = useState(segments[0]?.[0] ?? 0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bottom = window.innerHeight - FOOTER_PX;
      let ms = segments[0]?.[0] ?? 0;
      for (let b = 0; b < blockCount; b++) {
        const el = blockRefs.current[b];
        if (!el || el.getBoundingClientRect().top >= bottom) break;
        const rows = el.querySelectorAll<HTMLElement>('[data-start]');
        if (!rows.length) {
          ms = segments[b * BLOCK]![0];
          continue;
        }
        let lo = 0;
        let hi = rows.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (rows[mid]!.getBoundingClientRect().top < bottom) {
            ms = Number(rows[mid]!.dataset.start);
            lo = mid + 1;
          } else hi = mid - 1;
        }
      }
      setPosition(ms);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [segments, blockCount]);

  const seek = useCallback((ms: number) => {
    const seconds = Math.floor(ms / 1000);
    seekTo(ms / 1000);
    // The position goes into the address for a shared link, without a navigation (rule 5).
    const url = new URL(window.location.href);
    url.searchParams.set('t', String(seconds));
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const used = useMemo(() => new Set(segments.map((s) => s[2]).filter(Boolean)), [segments]);
  const count = Object.values(speakers).filter((s) => used.has(s.id)).length;
  const editingSpeaker = editing ? speakers[editing] : undefined;

  return (
    <div>
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-line-subtle px-5 py-3 text-xs text-muted-foreground max-shell:px-4">
        {canEdit && count > 0 ? (
          <>
            <span className="max-shell:hidden">{t('head', { language: languageName, count })}</span>
            <span className="hidden max-shell:inline">
              {t('headShort', { language: languageName, count })}
            </span>
          </>
        ) : (
          <span>{t('headShort', { language: languageName, count })}</span>
        )}
      </div>
      {failed && (
        <p role="alert" className="border-b border-line-subtle px-5 py-2 text-sm text-destructive">
          {ts('failed')}
        </p>
      )}
      <div
        ref={listRef}
        role="list"
        aria-label={t('label')}
        className="grid gap-6 px-5 py-6 max-shell:px-4 max-shell:py-5"
      >
        {Array.from({ length: blockCount }, (_, b) => {
          const from = b * BLOCK;
          const to = Math.min(segments.length, from + BLOCK);
          const visible = shown.has(b);
          return (
            <div
              key={b}
              data-block={b}
              ref={(el) => {
                blockRefs.current[b] = el;
              }}
              style={
                visible
                  ? undefined
                  : { height: heights.current.get(b) ?? (to - from) * ESTIMATE_PX }
              }
            >
              {visible && (
                <div className="grid gap-6">
                  {segments.slice(from, to).map((segment, k) => {
                    const i = from + k;
                    const speaker = segment[2] ? speakers[segment[2]] : undefined;
                    return (
                      <Segment
                        key={i}
                        index={i}
                        segment={segment}
                        name={nameOf(speaker)}
                        speaker={speaker}
                        playing={i === playing}
                        canEdit={canEdit && Boolean(speaker)}
                        language={language}
                        pattern={pattern}
                        onSeek={seek}
                        onEdit={(button) => {
                          openers.current.set(speaker!.id, button);
                          setEditing(speaker!.id);
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="sticky bottom-0 border-t border-line-subtle bg-card px-5 py-3 text-xs text-muted-foreground tabular-nums max-shell:px-4">
        {t('position', {
          position: formatClock(position / 1000),
          duration: formatClock(durationS),
        })}
      </p>
      {canEdit && editingSpeaker && (
        <SpeakerDialog
          open
          onOpenChange={(open) => {
            if (!open) close(editingSpeaker.id);
          }}
          meetingId={meetingId}
          initial={{
            label:
              editingSpeaker.unnamed !== null && !editingSpeaker.user ? '' : nameOf(editingSpeaker),
            user: editingSpeaker.user,
          }}
          placeholder={nameOf({ ...editingSpeaker, user: null })}
          onSave={(draft) => void save(editingSpeaker.id, draft)}
        />
      )}
    </div>
  );
}

const Segment = memo(function Segment({
  index,
  segment,
  name,
  speaker,
  playing,
  canEdit,
  language,
  pattern,
  onSeek,
  onEdit,
}: {
  index: number;
  segment: SegmentTuple;
  name: string;
  speaker: SpeakerView | undefined;
  playing: boolean;
  canEdit: boolean;
  language: string;
  pattern: RegExp | null;
  onSeek: (ms: number) => void;
  onEdit: (button: HTMLButtonElement) => void;
}) {
  const t = useTranslations('transcript');
  const [start, , , text] = segment;
  const clock = formatClock(start / 1000);
  const named = Boolean(speaker && (speaker.user || speaker.unnamed === null));
  const label = (
    <>
      {named && <Avatar name={name} className="size-6 text-[9px]" />}
      <span className="break-words">{name}</span>
    </>
  );
  const parts = useMemo(() => highlight(text, pattern), [text, pattern]);
  return (
    <div
      role="listitem"
      data-index={index}
      data-start={start}
      aria-current={playing ? 'time' : undefined}
      className={cn(playing && '-ml-3.5 border-l-2 border-accent-strong pl-3')}
    >
      <div className="mb-2 flex items-center gap-2">
        {!speaker ? (
          // A segment the provider gave no speaker: the timestamp alone.
          <span />
        ) : canEdit ? (
          <button
            type="button"
            className="inline-flex min-h-8 items-center gap-2 rounded-control text-left text-[13px] font-[550] hover:underline hover:underline-offset-4 max-shell:min-h-11"
            aria-label={t('speaker.rename', { name })}
            aria-haspopup="dialog"
            onClick={(e) => onEdit(e.currentTarget)}
          >
            {label}
            {!named && (
              <Pencil
                aria-hidden="true"
                className="size-3 text-muted-foreground"
                strokeWidth={1.5}
              />
            )}
          </button>
        ) : (
          <span className="inline-flex min-h-8 items-center gap-2 text-[13px] font-[550]">
            {label}
          </span>
        )}
        {playing && <span className="sr-only">{t('playing')}</span>}
        <button
          type="button"
          className="ml-auto min-h-8 rounded-control px-1 text-xs text-muted-foreground tabular-nums hover:text-foreground hover:underline hover:underline-offset-4 max-shell:min-h-11"
          aria-label={t('seek', { time: clock })}
          onClick={() => onSeek(start)}
        >
          <time dateTime={`PT${Math.floor(start / 1000)}S`}>{clock}</time>
        </button>
      </div>
      <p lang={language || undefined} className="text-base leading-[1.7] tracking-[-0.01em]">
        {parts.map((part, k) =>
          part.mark ? (
            <mark key={k} className="rounded-[3px] bg-accent px-[3px] py-px text-accent-foreground">
              {part.text}
            </mark>
          ) : (
            part.text
          ),
        )}
      </p>
    </div>
  );
});
