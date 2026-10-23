// The live transcript as the window holds it, with the session and the
// number of the last update applied: every finished line of the
// running recording with where it starts, the line in progress, and the
// state. Updates from Rust append; `reset` clears first. A `stopped`
// update, or a snapshot with no live session, clears everything: the
// preview is never kept after the recording stops.

import type { LiveLine, LiveTranscript, LiveUpdate } from './types';

export const EMPTY: LiveTranscript = {
  state: '',
  reason: null,
  lines: [],
  partial: null,
  session: 0,
  seq: 0,
};

export function apply(t: LiveTranscript, u: LiveUpdate): LiveTranscript {
  if (u.state === 'stopped') return { ...EMPTY, state: 'stopped', session: u.session, seq: u.seq };
  const base = u.reset ? EMPTY : t;
  return {
    state: u.state,
    reason: u.reason,
    lines: u.append.length ? [...base.lines, ...u.append] : base.lines,
    partial: u.partial,
    session: u.session,
    seq: u.seq,
  };
}

/**
 * Apply an update unless the window already has it: an older session, or a
 * number at or below the last one applied in this session, is skipped. A
 * newer session starts clean even if its first update was missed.
 */
export function accept(t: LiveTranscript, u: LiveUpdate): LiveTranscript {
  if (u.session < t.session) return t;
  if (u.session === t.session && u.seq <= t.seq) return t;
  if (u.session > t.session && !u.reset && u.state !== 'stopped')
    return apply({ ...EMPTY }, { ...u, reset: true });
  return apply(t, u);
}

/** The state fetched at startup, with the updates that arrived meanwhile. */
export function reconcile(state: LiveTranscript, buffered: LiveUpdate[]): LiveTranscript {
  return buffered.reduce(accept, state);
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
