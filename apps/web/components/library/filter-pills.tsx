'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from 'cn';

export interface Pill {
  value: string;
  label: string;
  /** Already formatted for the locale. */
  count?: string;
}

/**
 * Filter pills: real buttons with aria-pressed, the selection kept in the URL
 * (behaviour.md rule 5). The first pill is "all" and clears the parameter.
 * Reused by every filterable list (rule 7).
 */
export function FilterPills({
  label,
  pills,
  param = 'filter',
  className,
}: {
  label: string;
  pills: Pill[];
  param?: string;
  /** Replaces the default block margins, for a list that places the pills in its own row. */
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const selected = searchParams.get(param) ?? pills[0]?.value;

  const select = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === pills[0]?.value) next.delete(param);
    else next.set(param, value);
    next.delete('page');
    const query = next.toString();
    startTransition(() =>
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }),
    );
  };

  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex flex-wrap gap-2 max-shell:gap-1.5', className ?? 'my-6 max-shell:my-5')}
    >
      {pills.map((pill) => {
        const pressed = pill.value === selected;
        return (
          <button
            key={pill.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => select(pill.value)}
            className={cn(
              'min-h-9 rounded-pill border border-border bg-card px-3.5 py-[7px] text-sm whitespace-nowrap transition-[background-color,color,border-color] hover:bg-secondary max-shell:min-h-11 max-shell:px-3 max-shell:text-xs',
              pressed &&
                'border-accent-line-control bg-accent-tint text-accent-foreground hover:bg-accent-tint',
            )}
          >
            {pill.label}
            {pill.count !== undefined && (
              <span className="ml-2 text-muted-foreground">{pill.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
