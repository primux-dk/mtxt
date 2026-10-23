// The live transcript as the window holds it: every finished line of the
// running recording with where it starts, the line in progress, and the
// state. Updates from Rust append; `reset` clears first. A `stopped`
// update, or a snapshot with no live session, clears everything: the
// preview is never kept after the recording stops.

import type { LiveLine, LiveTranscript, LiveUpdate } from './types';

export const EMPTY: LiveTranscript = { state: 'loading', reason: null, lines: [], partial: null };

export function apply(t: LiveTranscript, u: LiveUpdate): LiveTranscript {
  if (u.state === 'stopped') return { ...EMPTY, state: 'stopped' };
  const base = u.reset ? EMPTY : t;
  return {
    state: u.state,
    reason: u.reason,
    lines: u.append.length ? [...base.lines, ...u.append] : base.lines,
    partial: u.partial,
  };
}

/** The status line shown under the text, as a locale key, or null. */
export function statusKey(t: LiveTranscript): string | null {
  switch (t.state) {
    case 'loading':
      return 'live.loading';
    case 'needs_model':
      return 'live.needsModel';
    case 'error':
      return t.reason ? 'live.errorReason' : 'live.error';
    case 'paused':
      return 'live.paused';
    case 'listening':
      return t.lines.length || t.partial ? null : 'live.listening';
    default:
      return null;
  }
}

/** The list is at its end (within a few pixels): new lines keep it there. */
export function atBottom(el: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
}

export type { LiveLine };
