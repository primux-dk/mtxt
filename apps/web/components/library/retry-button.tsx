'use client';

import { RotateCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

/** Fetches the page again. Keeps its label while it works (README component inventory). */
export function RetryButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button aria-busy={pending} onClick={() => startTransition(() => router.refresh())}>
      <RotateCw aria-hidden="true" />
      {label}
    </Button>
  );
}
