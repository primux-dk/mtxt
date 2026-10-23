// What the live window shows for an update: the last finished line (muted)
// and the line in progress, or a status line. A `stopped` update, or a
// snapshot with no live session, clears everything: the preview is never
// kept after the recording stops.

import type { LiveUpdate } from './types';

export interface LiveText {
  prev: string;
  current: string;
  /** The locale key of a status line instead of text. */
  status: string | null;
  paused: boolean;
}

export const EMPTY: LiveText = { prev: '', current: '', status: null, paused: false };

export function view(u: LiveUpdate | null): LiveText {
  if (!u || u.state === 'stopped') return EMPTY;
  const status = (key: string, paused = false): LiveText => ({
    prev: '',
    current: '',
    status: key,
    paused,
  });
  switch (u.state) {
    case 'loading':
      return status('live.loading');
    case 'needs_model':
      return status('live.needsModel');
    case 'error':
      return status('live.error');
    case 'paused':
      return status('live.paused', true);
  }
  const lines = [...u.lines];
  if (u.partial) lines.push(u.partial);
  if (lines.length === 0) return status('live.listening');
  const current = lines.pop() ?? '';
  return { prev: lines.pop() ?? '', current, status: null, paused: false };
}
