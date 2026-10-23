'use client';

import { Laptop, RotateCw, Unplug } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  disconnectRecorder,
  listMyRecorders,
  type RecorderRow,
} from '@/app/(app)/recorders/actions';
import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type ListState = { state: 'loading' | 'failed' } | { state: 'done'; recorders: RecorderRow[] };

const DATE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/**
 * "Recorders" in the user slot: the desktop recorders connected to the
 * signed-in user, with Disconnect (docs/spec.md "Recorder connection"). The
 * list loads when the dialog opens. Disconnect is optimistic: the row goes at
 * once and comes back with a message if the server refuses (behaviour.md
 * rule 2). The Dialog traps focus and returns it to the opener (rule 11).
 */
export function RecordersDialog() {
  const t = useTranslations('recorders');
  const common = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ListState>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = async () => {
    const n = ++asked.current;
    setList({ state: 'loading' });
    let result: Awaited<ReturnType<typeof listMyRecorders>>;
    try {
      result = await listMyRecorders();
    } catch {
      result = { ok: false };
    }
    if (n !== asked.current) return;
    setList(result.ok ? { state: 'done', recorders: result.recorders } : { state: 'failed' });
  };

  useEffect(() => {
    if (open) void load();
    else setError(null);
  }, [open]);

  const disconnect = async (recorder: RecorderRow, index: number) => {
    setError(null);
    setList((current) =>
      current.state === 'done'
        ? { state: 'done', recorders: current.recorders.filter((r) => r.id !== recorder.id) }
        : current,
    );
    // Focus moves to the row that takes this one's place, else to the heading.
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('[data-recorder-disconnect]');
      (rows[Math.min(index, rows.length - 1)] ?? heading.current)?.focus();
    });
    let result: Awaited<ReturnType<typeof disconnectRecorder>>;
    try {
      result = await disconnectRecorder(recorder.id);
    } catch {
      result = { ok: false, code: 'server' };
    }
    // Already gone on the server (another window disconnected it): the row stays away.
    if (result.ok || result.code === 'not_found') return;
    setList((current) =>
      current.state === 'done'
        ? {
            state: 'done',
            recorders: [...current.recorders, recorder].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            ),
          }
        : current,
    );
    setError(t('disconnectFailed', { device: recorder.deviceName }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="quiet" className="w-full justify-start px-2">
          <Laptop aria-hidden="true" />
          {t('open')}
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={common('close')}
        className="max-w-[560px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
      >
        <div className="grid gap-2">
          <DialogTitle ref={heading} tabIndex={-1} className="outline-none">
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
            {error}
          </p>
        )}

        {list.state === 'loading' && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('loading')}
          </p>
        )}
        {list.state === 'failed' && (
          <div role="alert" className="grid justify-items-start gap-3">
            <p className="text-sm text-destructive">{t('failed')}</p>
            <Button onClick={() => void load()}>
              <RotateCw aria-hidden="true" />
              {t('retry')}
            </Button>
          </div>
        )}
        {list.state === 'done' && list.recorders.length === 0 && (
          <div className="grid gap-1 rounded-control border border-border px-4 py-5 text-sm">
            <p className="font-[550]">{t('empty.title')}</p>
            <p className="text-muted-foreground">{t('empty.body')}</p>
          </div>
        )}
        {list.state === 'done' && list.recorders.length > 0 && (
          <section aria-labelledby="recorders-count" className="grid gap-2">
            <h3 id="recorders-count" className="text-sm font-[550]">
              {t('count', { count: list.recorders.length })}
            </h3>
            <ul
              data-testid="recorders-list"
              className="max-h-[min(420px,55dvh)] overflow-y-auto rounded-control border border-border"
            >
              {list.recorders.map((r, i) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 border-b border-line-subtle px-3 py-3 last:border-b-0"
                >
                  <Laptop
                    aria-hidden="true"
                    strokeWidth={1.5}
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 grow">
                    <p className="font-[550] [overflow-wrap:anywhere]">{r.deviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('since')} <LocalTime date={r.createdAt} options={DATE} />
                      {' · '}
                      {r.lastUsedAt ? (
                        <>
                          {t('lastUsed')} <LocalTime date={r.lastUsedAt} options={DATE} />
                        </>
                      ) : (
                        t('neverUsed')
                      )}
                    </p>
                  </div>
                  <Button
                    data-recorder-disconnect
                    aria-label={t('disconnectLabel', { device: r.deviceName })}
                    onClick={() => void disconnect(r, i)}
                  >
                    <Unplug aria-hidden="true" />
                    <span className="max-shell:sr-only">{t('disconnect')}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
