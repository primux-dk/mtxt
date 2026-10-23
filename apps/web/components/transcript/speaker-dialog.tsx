'use client';

import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { searchColleagues, type Colleague } from '@/app/(app)/meetings/speaker-actions';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface SpeakerDraft {
  label: string;
  user: Colleague | null;
}

/**
 * Rename a speaker and link it to a colleague (figure 04, behaviour.md rules
 * 7 and 11): the shared dialog, so the title, the close path, the focus trap
 * and the return of focus to the speaker button come with it. Search runs
 * as the owner types, a quarter second after the last key. Save hands the
 * draft back; the transcript applies it at once and rolls back on failure.
 */
export function SpeakerDialog({
  open,
  onOpenChange,
  meetingId,
  initial,
  placeholder,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  initial: SpeakerDraft;
  /** "Speaker 3" in the reader's language, for a speaker with no name yet. */
  placeholder: string;
  onSave: (draft: SpeakerDraft) => void;
}) {
  const t = useTranslations('speaker');
  const common = useTranslations('common');
  const ids = {
    name: useId(),
    help: useId(),
    error: useId(),
    search: useId(),
    searchHelp: useId(),
  };
  const [label, setLabel] = useState(initial.label);
  const [user, setUser] = useState<Colleague | null>(initial.user);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Colleague[] | null>(null);
  const [searchState, setSearchState] = useState<'idle' | 'searching' | 'failed'>('idle');
  const [error, setError] = useState(false);

  // A fresh draft when the dialog opens, and only then: the page re-renders a few times a
  // second while audio plays, and a typed name must survive that.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (!open) return;
    setLabel(initialRef.current.label);
    setUser(initialRef.current.user);
    setQuery('');
    setResults(null);
    setSearchState('idle');
    setError(false);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearchState('idle');
      return;
    }
    let live = true;
    setSearchState('searching');
    const timer = setTimeout(async () => {
      try {
        const found = await searchColleagues(meetingId, q);
        if (!live) return;
        if (found === null) throw new Error('refused');
        setResults(found);
        setSearchState('idle');
      } catch {
        if (live) setSearchState('failed');
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, meetingId]);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) {
      setError(true);
      return;
    }
    onSave({ label: name, user });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={common('close')} aria-describedby={ids.help}>
        <DialogTitle>{t('rename.title')}</DialogTitle>
        <form className="grid gap-5" onSubmit={save} noValidate>
          <div className="grid gap-2">
            <label htmlFor={ids.name} className="font-[550]">
              {t('rename.field')}
            </label>
            <Input
              id={ids.name}
              value={label}
              placeholder={placeholder}
              maxLength={120}
              autoComplete="off"
              aria-invalid={error}
              aria-describedby={[ids.help, error ? ids.error : ''].filter(Boolean).join(' ')}
              onChange={(e) => {
                setLabel(e.target.value);
                setError(false);
              }}
            />
            <DialogDescription id={ids.help} className="text-xs">
              {t('rename.help')}
            </DialogDescription>
            {error && (
              <p id={ids.error} className="text-xs text-destructive">
                {t('rename.required')}
              </p>
            )}
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 font-[550]">{t('link.heading')}</legend>
            <p className="text-xs text-muted-foreground">{t('link.help')}</p>
            {user && (
              <div className="flex flex-wrap items-center gap-2 rounded-control border border-accent-line bg-accent-tint-soft px-3 py-2">
                <Avatar name={user.name} className="size-6 text-[9px]" />
                <span className="min-w-0 grow break-words">
                  {t('link.linked', { name: user.name })}
                </span>
                <Button variant="quiet" onClick={() => setUser(null)}>
                  {t('link.unlink')}
                </Button>
              </div>
            )}
            <label htmlFor={ids.search} className="text-sm">
              {t('link.search')}
            </label>
            <Input
              id={ids.search}
              type="search"
              value={query}
              autoComplete="off"
              aria-describedby={ids.searchHelp}
              onChange={(e) => setQuery(e.target.value)}
            />
            <p id={ids.searchHelp} className="text-xs text-muted-foreground">
              {t('link.searchHelp')}
            </p>
            <div aria-live="polite" className="grid gap-1">
              {searchState === 'searching' && (
                <p className="text-xs text-muted-foreground">{t('link.searching')}</p>
              )}
              {searchState === 'failed' && (
                <p className="text-xs text-destructive">{t('link.searchFailed')}</p>
              )}
              {searchState === 'idle' && results?.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('link.none')}</p>
              )}
              {searchState === 'idle' && results && results.length > 0 && (
                <ul className="grid gap-1" aria-label={t('link.search')}>
                  {results.map((c) => {
                    const chosen = user?.id === c.id;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          aria-pressed={chosen}
                          aria-label={t('link.choose', { name: c.name, email: c.email })}
                          onClick={() => {
                            setUser(c);
                            // A linked speaker carries the colleague's name.
                            setLabel(c.name);
                            setError(false);
                          }}
                          className={cn(
                            'flex min-h-11 w-full items-center gap-3 rounded-control border border-transparent px-2 py-1.5 text-left hover:bg-secondary',
                            chosen && 'border-accent-line-control bg-accent-tint',
                          )}
                        >
                          <Avatar name={c.name} className="size-7 text-[10px]" />
                          <span className="min-w-0 grow">
                            <span className="block break-words">{c.name}</span>
                            <span className="block text-xs break-all text-muted-foreground">
                              {c.email}
                            </span>
                          </span>
                          {chosen && <Check aria-hidden="true" className="size-4" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </fieldset>

          <DialogFooter>
            <Button variant="quiet" onClick={() => onOpenChange(false)}>
              {common('cancel')}
            </Button>
            <Button type="submit" variant="primary">
              {t('rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
