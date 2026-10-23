'use client';

/*
  Autosave for the recap editor (behaviour.md rules 1 and 4). A change
  schedules a save 1.5 s after the last one; a tick of a decision saves at
  once. Every save carries the base version and becomes a version on the
  server, or is refused because the base is no longer current. The status
  word follows what the server confirmed: "Saved" only after a save of the
  text now in the editor came back; "Saving" while one is due or on its way;
  "Not saved" while offline or after a failure, with retries; "Changed
  elsewhere" when the server has a newer version, and saving stops.

  The text is kept in IndexedDB (lib/recap/local-draft.ts) from the first
  change until the server confirms it.
*/
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDraft, putDraft } from '@/lib/recap/local-draft';
import type { VersionView } from '@/lib/recap/view';

export const AUTOSAVE_MS = 1500;
const RETRY_MS = 5000;

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'conflict';
export type SaveProblem = 'offline' | 'too_long' | 'refused' | null;

export interface SaveState {
  status: SaveStatus;
  problem: SaveProblem;
  /** The newer version that refused the save. */
  conflict: VersionView | null;
  current: VersionView | null;
}

export function useAutosave(options: {
  meetingId: string;
  recapId: string;
  initial: VersionView | null;
  /** The markdown the server has for `initial`. */
  initialMd: string;
  /** The editor's markdown now. */
  read: () => string;
  /** A new version landed (the version line, the decisions). */
  onSaved?: (version: VersionView) => void;
}) {
  const { meetingId, recapId } = options;
  const [state, setState] = useState<SaveState>({
    status: 'saved',
    problem: null,
    conflict: null,
    current: options.initial,
  });
  const base = useRef<string | null>(options.initial?.id ?? null);
  const confirmed = useRef(options.initialMd);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  const read = useRef(options.read);
  read.current = options.read;
  const onSaved = useRef(options.onSaved);
  onSaved.current = options.onSaved;

  const set = (patch: Partial<SaveState>) => setState((s) => ({ ...s, ...patch }));

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    if (stopped.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const body = read.current();
    if (body === confirmed.current) {
      set({ status: 'saved', problem: null });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      set({ status: 'unsaved', problem: 'offline' });
      return;
    }
    inFlight.current = true;
    set({ status: 'saving' });
    const sentOn = base.current;
    let response: Response | null = null;
    try {
      response = await fetch(`/api/v1/meetings/${meetingId}/recap`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base_version_id: sentOn, body_md: body }),
        cache: 'no-store',
      });
    } catch {
      response = null;
    }
    inFlight.current = false;
    if (response?.ok) {
      const { version } = (await response.json()) as { version: VersionView };
      base.current = version.id;
      confirmed.current = body;
      void deleteDraft(recapId, sentOn).catch(() => {});
      onSaved.current?.(version);
      const now = read.current();
      if (now !== body) {
        // Typed during the save: keep it under the new base, and save it too.
        void putDraft({
          recapId,
          baseVersionId: version.id,
          bodyMd: now,
          savedAt: Date.now(),
        }).catch(() => {});
        set({ current: version, status: 'saving', problem: null });
        timer.current = setTimeout(() => void save(), again.current ? 0 : AUTOSAVE_MS);
      } else set({ current: version, status: 'saved', problem: null });
      again.current = false;
      return;
    }
    if (response?.status === 409) {
      const { current } = (await response.json().catch(() => ({}))) as { current?: VersionView };
      stopped.current = true;
      set({ status: 'conflict', conflict: current ?? null });
      return;
    }
    const problem: SaveProblem =
      response === null ? 'offline' : response.status === 413 ? 'too_long' : 'refused';
    set({ status: 'unsaved', problem });
    // A network error or the server's own failure: try again; a refusal waits for the next change.
    if (problem === 'offline' || (response && response.status >= 500)) {
      timer.current = setTimeout(() => void save(), RETRY_MS);
    }
  }, [meetingId, recapId]);

  /** The editor changed: keep it locally, and save after a pause (`now` for a tick). */
  const changed = useCallback(
    (now = false) => {
      if (stopped.current) return;
      const body = read.current();
      if (body === confirmed.current) {
        if (!inFlight.current) set({ status: 'saved', problem: null });
        clearTimeout(timer.current);
        return;
      }
      void putDraft({
        recapId,
        baseVersionId: base.current,
        bodyMd: body,
        savedAt: Date.now(),
      }).catch(() => {});
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      set(offline ? { status: 'unsaved', problem: 'offline' } : { status: 'saving' });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), now ? 0 : AUTOSAVE_MS);
    },
    [recapId, save],
  );

  /** A version made elsewhere in this window (Restore): the editor now holds it. */
  const adopt = useCallback(
    (version: VersionView, bodyMd: string) => {
      void deleteDraft(recapId, base.current).catch(() => {});
      base.current = version.id;
      confirmed.current = bodyMd;
      stopped.current = false;
      set({ current: version, status: 'saved', problem: null, conflict: null });
    },
    [recapId],
  );

  /** Text restored from IndexedDB on top of `baseId`: unsaved until the server has it. */
  const restoreLocal = useCallback(
    (baseId: string | null) => {
      base.current = baseId;
      changed(true);
    },
    [changed],
  );

  useEffect(() => {
    const online = () => {
      if (!stopped.current && read.current() !== confirmed.current) void save();
    };
    const offline = () => {
      if (!stopped.current && read.current() !== confirmed.current)
        set({ status: 'unsaved', problem: 'offline' });
    };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    // Leaving with text the server does not have: the browser asks first.
    const leave = (e: BeforeUnloadEvent) => {
      if (read.current() !== confirmed.current && !stopped.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('beforeunload', leave);
      clearTimeout(timer.current);
    };
  }, [save]);

  return { state, changed, save, adopt, restoreLocal, base };
}
