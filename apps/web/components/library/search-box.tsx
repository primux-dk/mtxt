import { Search } from 'lucide-react';

/**
 * Search over what the user may see. A plain GET form, so the query lives in
 * the URL (behaviour.md rule 5) and works without JavaScript. Reused by every
 * searchable list (rule 7).
 */
export function SearchBox({
  action,
  name = 'q',
  defaultValue,
  label,
  placeholder,
  hidden = {},
}: {
  action: string;
  name?: string;
  defaultValue?: string;
  label: string;
  placeholder: string;
  /** Other URL state to keep when searching, for example the view. */
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form
      action={action}
      method="get"
      role="search"
      className="w-[420px] max-w-full max-shell:w-full"
    >
      {Object.entries(hidden).map(([key, value]) =>
        value ? <input key={key} type="hidden" name={key} value={value} /> : null,
      )}
      <label className="flex h-10 items-center gap-2 rounded-control border border-input bg-card px-3 text-muted-foreground transition-[border-color] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring max-shell:h-11">
        <Search aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.5} />
        <input
          type="search"
          name={name}
          defaultValue={defaultValue}
          aria-label={label}
          placeholder={placeholder}
          className="w-full min-w-0 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />
      </label>
    </form>
  );
}
