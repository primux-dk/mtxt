'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-renders the page from the server every few seconds while it is in the
 * page: the transcribing state uses it so the transcript appears without a
 * reload. Stops when the tab is hidden.
 */
export function RefreshWhile({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
