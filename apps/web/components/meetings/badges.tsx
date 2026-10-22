import { Building2, Lock, TriangleAlert, Users } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from 'cn';
import type { Visibility } from '@mtxt/adapters';
import type { MeetingState } from '@/lib/meetings/queries';

const VISIBILITY_ICON = { private: Lock, shared: Users, company: Building2 } as const;

/** Visibility as a word with an icon, never colour alone (behaviour.md rule 11). */
export async function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const t = await getTranslations('visibility');
  const Icon = VISIBILITY_ICON[visibility];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-card px-[9px] py-[3px] text-xs leading-[1.5] whitespace-nowrap">
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      {t(visibility)}
    </span>
  );
}

/** The processing state as a word with a dot or a warning icon. */
export async function StateBadge({ state }: { state: MeetingState }) {
  const t = await getTranslations('status');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs whitespace-nowrap',
        state === 'ready' && 'text-accent-strong',
        state === 'failed' && 'text-destructive',
        (state === 'transcribing' || state === 'uploading' || state === 'none') &&
          'text-muted-foreground',
      )}
    >
      {state === 'failed' ? (
        <TriangleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
      ) : (
        <span
          aria-hidden="true"
          className="inline-block size-1.5 shrink-0 rounded-full bg-current"
        />
      )}
      {t(state)}
    </span>
  );
}
