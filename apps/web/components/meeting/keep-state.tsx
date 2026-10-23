'use client';

import { createContext, useContext, useRef, useState } from 'react';
import { setKeep } from '@/app/(app)/meetings/actions';
import { safely } from '@/lib/safe-action';

interface KeepState {
  keep: boolean;
  failed: boolean;
  set(next: boolean): void;
}

const Context = createContext<KeepState | null>(null);

/**
 * The keep flag of one meeting, optimistic (behaviour.md rule 2), shared by
 * the Keep toggle in the actions row and the Keep in the retention notice,
 * so both always show the same value. One request is in flight at a time;
 * clicks meanwhile only change the wanted value, and when the request
 * returns the latest wanted value is sent if it differs. On a failure both
 * go back to the last value the server acknowledged.
 */
export function KeepProvider({
  meetingId,
  keep,
  children,
}: {
  meetingId: string;
  keep: boolean;
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState(keep);
  const [failed, setFailed] = useState(false);
  const acked = useRef(keep);
  const wanted = useRef(keep);
  const sending = useRef(false);

  const flush = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (wanted.current !== acked.current) {
        const value = wanted.current;
        const result = await safely(() => setKeep(meetingId, value));
        if (!result.ok) {
          wanted.current = acked.current;
          setShown(acked.current);
          setFailed(true);
          return;
        }
        acked.current = value;
      }
    } finally {
      sending.current = false;
    }
  };

  const set = (next: boolean) => {
    setShown(next);
    setFailed(false);
    wanted.current = next;
    void flush();
  };

  return <Context.Provider value={{ keep: shown, failed, set }}>{children}</Context.Provider>;
}

export function useKeep(): KeepState {
  const state = useContext(Context);
  if (!state) throw new Error('useKeep() needs a KeepProvider');
  return state;
}
