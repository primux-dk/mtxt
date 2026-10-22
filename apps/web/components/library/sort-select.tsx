'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * A select kept in the URL, the sort order by default; changing it goes back
 * to page 1, and the first option is the default and leaves the URL. Reused
 * by every list with a select filter (behaviour.md rule 7).
 */
export function SortSelect({
  label,
  options,
  param = 'sort',
}: {
  label: string;
  options: { value: string; label: string }[];
  param?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(param) ?? options[0]?.value;
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = new URLSearchParams(searchParams);
          if (event.target.value === options[0]?.value) next.delete(param);
          else next.set(param, event.target.value);
          next.delete('page');
          const query = next.toString();
          router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        }}
        className="min-h-8 rounded-control border border-input bg-card px-2 text-xs text-foreground max-shell:min-h-11"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
