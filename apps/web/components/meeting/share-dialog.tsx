'use client';

import { Search, UserMinus, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { findColleagues, setShare } from '@/app/(app)/meetings/sharing-actions';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Colleague } from '@/lib/meetings/queries';
import { safely } from '@/lib/safe-action';
import { searchLine, type SearchState } from './share-search-state';

/**
 * Who a shared meeting is shared with (README component inventory: named
 * sharing opens a Dialog with directory selection). Search the directory by
 * name or address, add, remove. Each add and remove is optimistic with
 * rollback (behaviour.md rule 2) and sets a value, so a retry adds no one
 * twice. The Dialog traps focus and returns it to its opener (rule 11).
 */
export function ShareDialog({
  open,
  onOpenChange,
  meetingId,
  title,
  readers,
  onReaders,
  ready,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  title: string;
  readers: Colleague[];
  onReaders: React.Dispatch<React.SetStateAction<Colleague[]>>;
  /** The meeting is `shared` on the server: adding may start. */
  ready: boolean;
}) {
  const t = useTranslations('share');
  const common = useTranslations('common');
  const [text, setText] = useState('');
  const [search, setSearch] = useState<SearchState>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const field = useRef<HTMLInputElement>(null);
  const asked = useRef(0);

  /** `quiet` refreshes the answer after a share change without the "Searching…" line. */
  const run = async (value: string, quiet = false) => {
    const n = ++asked.current;
    if (!quiet) setSearch({ state: 'loading' });
    let result: Awaited<ReturnType<typeof findColleagues>>;
    try {
      result = await findColleagues(meetingId, value);
    } catch {
      result = { ok: false, code: 'server' };
    }
    // Only the latest question's answer is shown; a failed refresh keeps the answer on screen.
    if (n !== asked.current || (quiet && !result.ok)) return;
    setSearch(
      result.ok
        ? {
            state: 'done',
            found: result.colleagues,
            others: result.others,
            addable: result.addable,
          }
        : { state: 'failed' },
    );
  };

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void run(text), text ? 200 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  useEffect(() => {
    if (!open) {
      setText('');
      setError(null);
      setSearch({ state: 'idle' });
    }
  }, [open]);

  const mark = (id: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const add = async (colleague: Colleague) => {
    setError(null);
    mark(colleague.id, true);
    onReaders((list) =>
      [...list.filter((r) => r.id !== colleague.id), colleague].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    field.current?.focus();
    const result = await safely(() => setShare(meetingId, colleague.id, true));
    mark(colleague.id, false);
    if (!result.ok) {
      onReaders((list) => list.filter((r) => r.id !== colleague.id));
      setError(t('addFailed', { name: colleague.name }));
      return;
    }
    // The server's list and count leave readers out, so they change with every share.
    void run(text, true);
  };

  const remove = async (colleague: Colleague, index: number) => {
    setError(null);
    mark(colleague.id, true);
    onReaders((list) => list.filter((r) => r.id !== colleague.id));
    // Focus moves to the row that takes this one's place, else to the search.
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('[data-share-remove]');
      (rows[Math.min(index, rows.length - 1)] ?? field.current)?.focus();
    });
    const result = await safely(() => setShare(meetingId, colleague.id, false));
    mark(colleague.id, false);
    if (!result.ok) {
      onReaders((list) => [...list, colleague].sort((a, b) => a.name.localeCompare(b.name)));
      setError(t('removeFailed', { name: colleague.name }));
      return;
    }
    void run(text, true);
  };

  const readerIds = new Set(readers.map((r) => r.id));
  const found = search.state === 'done' ? search.found.filter((c) => !readerIds.has(c.id)) : [];
  const line = searchLine({ ready, search, text, candidates: found.length });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={common('close')}
        className="max-w-[560px]"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="grid gap-2">
          <DialogTitle className="break-words">{t('title', { title })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </div>

        <div className="grid gap-2">
          <label htmlFor="share-search" className="text-sm font-[550]">
            {t('search.label')}
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.5}
            />
            <Input
              id="share-search"
              ref={field}
              type="search"
              autoComplete="off"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('search.placeholder')}
              aria-describedby="share-search-state"
              className="pl-9"
            />
          </div>
          <p id="share-search-state" aria-live="polite" className="text-xs text-muted-foreground">
            {line === 'none' ? t('search.none', { text }) : line ? t(`search.${line}`) : ''}
          </p>
          {search.state === 'failed' && (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
              {t('search.failed')}
              <Button variant="quiet" onClick={() => void run(text)}>
                {t('search.retry')}
              </Button>
            </p>
          )}
          {found.length > 0 && (
            <ul
              aria-label={t('search.results')}
              className="max-h-48 overflow-y-auto rounded-control border border-border"
            >
              {found.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-line-subtle px-3 py-2 last:border-b-0"
                >
                  <Avatar name={c.name} />
                  <span className="min-w-0 grow">
                    <span className="block truncate font-[550]">{c.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{c.email}</span>
                  </span>
                  <Button
                    disabled={!ready || busy.has(c.id)}
                    aria-label={t('add', { name: c.name })}
                    onClick={() => void add(c)}
                  >
                    <UserPlus aria-hidden="true" />
                    {t('addShort')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <section aria-labelledby="share-readers" className="grid gap-2">
          <h3 id="share-readers" className="text-sm font-[550]">
            {t('readers', { count: readers.length })}
          </h3>
          {readers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('nobody')}</p>
          ) : (
            <ul
              data-testid="share-readers"
              className="max-h-64 overflow-y-auto rounded-control border border-border"
            >
              {readers.map((c, i) => (
                <li
                  key={c.id}
                  className="flex items-center gap-3 border-b border-line-subtle px-3 py-2 last:border-b-0"
                >
                  <Avatar name={c.name} />
                  <span className="min-w-0 grow">
                    <span className="block truncate font-[550]" title={c.name}>
                      {c.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground" title={c.email}>
                      {c.email}
                    </span>
                  </span>
                  <Button
                    variant="quiet"
                    size="icon"
                    data-share-remove
                    disabled={busy.has(c.id)}
                    aria-label={t('remove', { name: c.name })}
                    onClick={() => void remove(c, i)}
                  >
                    <UserMinus aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex justify-end">
          <DialogClose asChild>
            <Button>{t('done')}</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
