'use client';

import { Building2, Lock, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { VISIBILITIES, type Visibility } from '@mtxt/adapters';
import { setVisibility } from '@/app/(app)/meetings/sharing-actions';
import { Button } from '@/components/ui/button';
import type { Colleague } from '@/lib/meetings/queries';
import { safely } from '@/lib/safe-action';
import { ShareDialog } from './share-dialog';

const ICON = { private: Lock, shared: Users, company: Building2 } as const;

/**
 * The owner's visibility select, optimistic with rollback (behaviour.md
 * rule 2), the way KeepProvider works: the screen changes at once, one
 * request is in flight, and a failure puts back the value the server last
 * acknowledged and says so. Choosing Shared opens the share dialog; the
 * button beside the select reopens it and says how many have access.
 */
export function VisibilityControl({
  meetingId,
  title,
  visibility,
  shares,
}: {
  meetingId: string;
  title: string;
  visibility: Visibility;
  shares: Colleague[];
}) {
  const tm = useTranslations('meeting.visibility');
  const tv = useTranslations('visibility');
  const ts = useTranslations('share');
  const [shown, setShown] = useState(visibility);
  // What the server has; the dialog adds colleagues only once it is `shared` there.
  const [saved, setSaved] = useState(visibility);
  const [failed, setFailed] = useState<Visibility | null>(null);
  const [readers, setReaders] = useState(shares);
  const [open, setOpen] = useState(false);
  const acked = useRef(visibility);
  const wanted = useRef(visibility);
  const sending = useRef(false);
  const select = useRef<HTMLSelectElement>(null);
  const manage = useRef<HTMLButtonElement>(null);

  const flush = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (wanted.current !== acked.current) {
        const value = wanted.current;
        const result = await safely(() => setVisibility(meetingId, value));
        if (!result.ok) {
          setFailed(value);
          wanted.current = acked.current;
          setShown(acked.current);
          setOpen(false);
          return;
        }
        // Leaving shared removes the share rows on the server; the list follows.
        if (acked.current === 'shared' && value !== 'shared') setReaders([]);
        acked.current = value;
        setSaved(value);
      }
    } finally {
      sending.current = false;
    }
  };

  const change = (next: Visibility) => {
    setShown(next);
    setFailed(null);
    wanted.current = next;
    if (next === 'shared') setOpen(true);
    void flush();
  };

  const Icon = ICON[shown];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-2 text-xs">
        <Icon aria-hidden="true" className="size-5" strokeWidth={1.5} />
        <select
          ref={select}
          value={shown}
          aria-label={tm('label')}
          onChange={(event) => change(event.target.value as Visibility)}
          className="min-h-10 rounded-control border border-input bg-card px-3 text-sm max-shell:min-h-11 max-shell:text-xs"
        >
          {VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {tv(v)}
            </option>
          ))}
        </select>
      </label>
      {shown === 'shared' && (
        <Button
          ref={manage}
          onClick={() => setOpen(true)}
          className="max-shell:px-2.5 max-shell:text-xs"
        >
          <Users aria-hidden="true" />
          {ts('manage', { count: readers.length })}
        </Button>
      )}
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {tv('failed', { visibility: tv(acked.current) })}
        </span>
      )}
      <ShareDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Back to what opened it: the manage button when it is there, else the select.
          if (!next) requestAnimationFrame(() => (manage.current ?? select.current)?.focus());
        }}
        meetingId={meetingId}
        title={title}
        readers={readers}
        onReaders={setReaders}
        ready={saved === 'shared' && shown === 'shared'}
      />
    </span>
  );
}
