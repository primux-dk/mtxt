// The three-dot menu on a row of "Recent recordings": which items it offers
// and which are enabled. Rust refuses the same cases again (`delete_local`).
//
// - Save audio to…: whenever the audio is on this Mac.
// - Open in library: once the library has the recording.
// - Delete from this Mac: the local copy only. Never offered while the
//   recording records or uploads. Without a question for a confirmed
//   recording; with a named question for one the library does not have yet
//   (behaviour rule 3).

import type { QueueItem } from './types';

export interface MenuItem {
  id: 'save' | 'open' | 'delete';
  enabled: boolean;
  /** Ask by name before acting. */
  confirm?: boolean;
}

export function menuFor(q: QueueItem): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'save', enabled: q.has_file },
    { id: 'open', enabled: !!q.meeting_url },
  ];
  const busy = q.status === 'recording' || q.status === 'uploading' || q.active;
  if (!busy && q.has_file) {
    items.push({ id: 'delete', enabled: true, confirm: q.status !== 'confirmed' });
  }
  return items;
}

/** "Plan for november 2026-10-23.ogg", in local time. */
export function defaultFileName(q: Pick<QueueItem, 'title' | 'started_at'>): string {
  const d = new Date(q.started_at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${q.title.trim() || date} ${date}.ogg`;
}
