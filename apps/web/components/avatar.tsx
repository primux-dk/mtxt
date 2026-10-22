/** Up to two initials from the name; the avatar is decorative, the name is beside it. */
export const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toLocaleUpperCase())
    .join('');

export function Avatar({ name }: { name?: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-line-strong bg-accent-tint text-xs font-[550] text-accent-foreground"
    >
      {name ? initials(name) : null}
    </span>
  );
}
