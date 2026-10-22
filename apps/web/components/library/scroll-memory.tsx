'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

const KEY = 'mtxt.library';

/**
 * Brings the reader back to the same place in the library (behaviour.md
 * rule 6). Opening a meeting from the list stores the library URL and the
 * scroll position; coming back to that URL scrolls there again. The meeting
 * page's back link reads the URL too.
 */
export function ScrollMemory() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const url = search ? `${pathname}?${search}` : pathname;

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
        url: string;
        y: number;
        restore: boolean;
      } | null;
      if (saved?.restore && saved.url === url) {
        window.scrollTo(0, saved.y);
        sessionStorage.setItem(KEY, JSON.stringify({ ...saved, restore: false }));
      }
    } catch {}
    const remember = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[data-library-link]');
      if (!link) return;
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ url, y: window.scrollY, restore: true }));
      } catch {}
    };
    document.addEventListener('click', remember, true);
    return () => document.removeEventListener('click', remember, true);
  }, [url]);

  return null;
}

/** The library page the reader came from, and whether they have not been back since. */
export function savedLibrary(): { url: string; restore: boolean } | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
      url: string;
      restore: boolean;
    } | null;
  } catch {
    return null;
  }
}
