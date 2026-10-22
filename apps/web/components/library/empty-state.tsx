import type { LucideIcon } from 'lucide-react';
import { cn } from 'cn';

/**
 * The one empty-state panel. Lists use three variants that must look
 * different (behaviour.md rule 8): first use, no matches, and a failed fetch,
 * which never looks like an empty account.
 */
export function EmptyState({
  tone = 'accent',
  Icon,
  title,
  body,
  children,
}: {
  tone?: 'accent' | 'warning';
  Icon: LucideIcon;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section
      role={tone === 'warning' ? 'alert' : undefined}
      aria-labelledby="empty-title"
      className="grid min-h-[340px] place-items-center rounded-card border border-border bg-card p-10 text-center max-shell:px-5"
    >
      <div>
        <Icon
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn(
            'mx-auto mb-5 size-8',
            tone === 'warning' ? 'text-destructive' : 'text-accent-strong',
          )}
        />
        <h2 id="empty-title" className="text-xl">
          {title}
        </h2>
        <p className="mt-3 mb-6 text-sm text-muted-foreground">{body}</p>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </section>
  );
}
