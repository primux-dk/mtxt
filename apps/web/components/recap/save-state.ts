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
  /** A refused save undid a decision tick (rule 2). */
  tickUndone: boolean;
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
  /**
   * The server refused a save (a conflict or a 4xx): the editor rolls back
   * the decision ticks in it and says whether there were any (rule 2).
   */
  onRefused?: () => boolean;
  /** The server stored other text than it was sent (a foreign image or mention removed): show that. */
  onNormalized?: (bodyMd: string) => void;
}) {
  const { meetingId, recapId } = options;
  const [state, setState] = useState<SaveState>({
    status: 'saved',
    problem: null,
    tickUndone: false,
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
  const onRefused = useRef(options.onRefused);
  onRefused.current = options.onRefused;
  const onNormalized = useRef(options.onNormalized);
  onNormalized.current = options.onNormalized;

  /** Keeps the editor's text in IndexedDB, or removes the copy once it equals what the server has. */
  const keepLocal = useCallback(
    (body: string) => {
      if (body === confirmed.current) void deleteDraft(recapId, base.current).catch(() => {});
      else
        void putDraft({
          recapId,
          baseVersionId: base.current,
          bodyMd: body,
          savedAt: Date.now(),
        }).catch(() => {});
    },
    [recapId],
  );

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
      const { version, body_md: stored } = (await response.json()) as {
        version: VersionView;
        body_md?: string;
      };
      base.current = version.id;
      confirmed.current = stored ?? body;
      void deleteDraft(recapId, sentOn).catch(() => {});
      onSaved.current?.(version);
      // Screen and store agree: the stored text replaces the sent one, unless more was typed meanwhile.
      if (stored !== undefined && stored !== body && read.current() === body) {
        onNormalized.current?.(stored);
      }
      const now = read.current();
      if (now !== confirmed.current) {
        // Typed during the save: keep it under the new base, and save it too.
        void putDraft({
          recapId,
          baseVersionId: version.id,
          bodyMd: now,
          savedAt: Date.now(),
        }).catch(() => {});
        set({ current: version, status: 'saving', problem: null, tickUndone: false });
        timer.current = setTimeout(() => void save(), again.current ? 0 : AUTOSAVE_MS);
      } else set({ current: version, status: 'saved', problem: null, tickUndone: false });
      again.current = false;
      return;
    }
    if (response?.status === 409) {
      const { current } = (await response.json().catch(() => ({}))) as { current?: VersionView };
      // Network saves stop; the text typed from here on is still kept in this browser.
      stopped.current = true;
      const undone = onRefused.current?.() ?? false;
      set({ status: 'conflict', conflict: current ?? null, tickUndone: undone });
      return;
    }
    const problem: SaveProblem =
      response === null ? 'offline' : response.status === 413 ? 'too_long' : 'refused';
    // A refusal (not the network, not the server's own failure) undoes the ticks it carried.
    const refused = response !== null && response.status < 500;
    const undone = refused ? (onRefused.current?.() ?? false) : false;
    set({ status: 'unsaved', problem, tickUndone: undone });
    // A network error or the server's own failure: try again; a refusal waits for the next change.
    if (problem === 'offline' || (response && response.status >= 500)) {
      timer.current = setTimeout(() => void save(), RETRY_MS);
    }
  }, [meetingId, recapId]);

  /**
   * The editor changed: keep it locally, and save after a pause (`now` for a
   * tick). `localOnly` keeps it without a save (a rollback). After "Changed
   * elsewhere" nothing goes to the server, but the text is still kept.
   */
  const changed = useCallback(
    (now = false, localOnly = false) => {
      const body = read.current();
      keepLocal(body);
      if (stopped.current || localOnly) return;
      if (body === confirmed.current) {
        // Back to what the server has (an undo): no copy to keep, nothing to save.
        if (!inFlight.current) set({ status: 'saved', problem: null });
        clearTimeout(timer.current);
        return;
      }
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      set(offline ? { status: 'unsaved', problem: 'offline' } : { status: 'saving' });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), now ? 0 : AUTOSAVE_MS);
    },
    [keepLocal, save],
  );

  /** A version made elsewhere in this window (Restore): the editor now holds it. */
  const adopt = useCallback(
    (version: VersionView, bodyMd: string) => {
      void deleteDraft(recapId, base.current).catch(() => {});
      base.current = version.id;
      confirmed.current = bodyMd;
      stopped.current = false;
      set({ current: version, status: 'saved', problem: null, conflict: null, tickUndone: false });
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
    // After "Changed elsewhere" the text is kept in this browser and Reload offers it: no question.
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
