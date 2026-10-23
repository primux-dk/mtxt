'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

/** Marks the extra history entry that holds Back while there are unsaved changes. */
const MARK = '__mtxtUnsaved';

interface Leave {
  /** Runs when the changes may go: at once when there are none, after "Discard changes" otherwise. */
  go: () => void;
  /** The tab being opened, by name; without it the dialog says the page is being left. */
  destination?: string;
  /** Where focus goes when the dialog closes. */
  opener?: HTMLElement | null;
}

interface Guard {
  dirty: boolean;
  report: (source: string, dirty: boolean) => void;
  /** The settings tab the changes are on, by name, for the dialog. */
  setPlace: (place: string | null) => void;
  leave: (leave: Leave) => void;
  /** An in-app navigation that asks first. Replaces the held entry, so Back stays one step. */
  navigate: (href: string, options?: Omit<Leave, 'go'> & { scroll?: boolean }) => void;
  /** For a link's onClick: a plain click asks first; a new tab or window keeps the changes and goes. */
  linkClick: (e: React.MouseEvent<HTMLAnchorElement>, options?: Omit<Leave, 'go'>) => void;
}

const GuardContext = createContext<Guard | null>(null);

export function useUnsavedGuard() {
  const guard = useContext(GuardContext);
  if (!guard) throw new Error('useUnsavedGuard needs an UnsavedGuard around it.');
  return guard;
}

/** Reports a source of unsaved changes (a tab's form, the template editor) while it is mounted. */
export function useReportUnsaved(source: string, dirty: boolean) {
  const { report } = useUnsavedGuard();
  useEffect(() => report(source, dirty), [report, source, dirty]);
  useEffect(() => () => report(source, false), [report, source]);
}

const held = () => Boolean((window.history.state as Record<string, unknown> | null)?.[MARK]);

/**
 * Unsaved changes on a settings tab are never lost without a question
 * (behaviour rule 3's wording, packet 14). Every way out asks: the tab strip,
 * the sidebar and the user menu through `navigate` and `linkClick`, Back and
 * Forward through one extra history entry held while there are changes, and
 * reload or closing the window through the browser's own beforeunload prompt.
 */
export function UnsavedGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations('settings.tabs');
  const tc = useTranslations('common');
  const router = useRouter();
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const [place, setPlace] = useState<string | null>(null);
  const [asking, setAsking] = useState<Leave | null>(null);
  const dirty = Object.values(sources).some(Boolean);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Set while the changes are being discarded on the way out, so the held entry is not popped behind it.
  const leaving = useRef(false);
  // Set when this code pops the held entry itself, so the popstate it causes is not a Back.
  const popping = useRef(false);
  // Kept apart from `asking`, which is already cleared when the dialog hands focus back.
  const opener = useRef<HTMLElement | null>(null);

  const report = useCallback((source: string, value: boolean) => {
    setSources((s) => (Boolean(s[source]) === value ? s : { ...s, [source]: value }));
  }, []);

  // Hold Back while there are changes; let go of the entry once there are none.
  useEffect(() => {
    if (dirty) {
      if (!held()) {
        window.history.pushState(
          { ...window.history.state, [MARK]: true },
          '',
          window.location.href,
        );
      }
    } else if (leaving.current) {
      leaving.current = false;
    } else if (held()) {
      popping.current = true;
      window.history.back();
    }
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const prompt = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', prompt);
    return () => window.removeEventListener('beforeunload', prompt);
  }, [dirty]);

  const discard = useCallback(() => {
    leaving.current = true;
    setSources({});
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (popping.current) {
        popping.current = false;
        return;
      }
      // Back (or Forward) left the held entry: hold it again and ask.
      if (dirtyRef.current && !held()) {
        window.history.pushState(
          { ...window.history.state, [MARK]: true },
          '',
          window.location.href,
        );
        opener.current = null;
        setAsking({
          go: () => {
            // One step back is this page under the held entry, the second is where Back pointed.
            window.history.go(-2);
          },
        });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const leave = useCallback((l: Leave) => {
    if (!dirtyRef.current) return l.go();
    opener.current = l.opener ?? null;
    setAsking(l);
  }, []);

  const navigate = useCallback<Guard['navigate']>(
    (href, { scroll, ...options } = {}) =>
      leave({
        ...options,
        go: () => {
          // From the held entry, replace it: the page under it is already this one.
          if (held()) router.replace(href, { scroll });
          else router.push(href, { scroll });
        },
      }),
    [leave, router],
  );

  const linkClick = useCallback<Guard['linkClick']>(
    (e, options) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      if (!dirtyRef.current) return;
      e.preventDefault();
      navigate(e.currentTarget.getAttribute('href') ?? '/', options);
    },
    [navigate],
  );

  const guard = useMemo<Guard>(
    () => ({ dirty, report, setPlace, leave, navigate, linkClick }),
    [dirty, report, leave, navigate, linkClick],
  );

  return (
    <GuardContext.Provider value={guard}>
      {children}
      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent
          closeLabel={tc('close')}
          onCloseAutoFocus={(e) => {
            const target = opener.current;
            if (!target?.isConnected) return;
            // A click opens the dialog before its target takes focus, so Radix has no opener of its own.
            e.preventDefault();
            target.focus();
          }}
        >
          <DialogTitle>{t('discard.title')}</DialogTitle>
          <DialogDescription>
            {asking?.destination
              ? t('discard.body', { tab: place ?? '', next: asking.destination })
              : t('discard.bodyLeave', { tab: place ?? '' })}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t('discard.keep')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const next = asking!;
                discard();
                setAsking(null);
                next.go();
              }}
            >
              {t('discard.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GuardContext.Provider>
  );
}
