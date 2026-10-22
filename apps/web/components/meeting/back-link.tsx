'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { savedLibrary } from '@/components/library/scroll-memory';

/**
 * "All meetings". Back to the library page the reader came from, with its
 * search, filter and page, and its scroll position (behaviour.md rule 6).
 */
export function BackLink({ label }: { label: string }) {
  const router = useRouter();
  const [saved, setSaved] = useState<ReturnType<typeof savedLibrary>>(null);
  useEffect(() => setSaved(savedLibrary()), []);
  return (
    <Link
      href={saved?.url ?? '/meetings'}
      onClick={(event) => {
        // Opened from that list in this tab: the previous entry is the list, so go back to it.
        if (saved?.restore && window.history.length > 1) {
          event.preventDefault();
          router.back();
        }
      }}
      className="mb-6 inline-flex min-h-10 items-center gap-2 text-[13px] text-muted-foreground hover:text-foreground max-shell:mb-5"
    >
      <ArrowLeft aria-hidden="true" className="size-5" strokeWidth={1.5} />
      {label}
    </Link>
  );
}
