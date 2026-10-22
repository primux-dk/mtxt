import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LocalTime } from '@/components/local-time';
import type { LibraryRow } from '@/lib/meetings/queries';
import { StateBadge, VisibilityBadge } from './badges';
import { formatDuration } from './format';
import { RestoreButton } from './restore-button';

/**
 * The one meeting list (behaviour.md rule 7): a row per meeting with title,
 * date, duration, speakers, visibility and state, per figure 02. On a phone
 * the badges move under the title.
 */
export async function MeetingList({ rows, restore }: { rows: LibraryRow[]; restore?: boolean }) {
  const t = await getTranslations('format');
  const tm = await getTranslations('meeting');
  return (
    <ul
      className="overflow-hidden rounded-card border border-border bg-card"
      data-testid="meeting-list"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className="grid grid-cols-[minmax(0,1fr)_130px_118px] items-center gap-4 border-b border-line-subtle p-5 last:border-b-0 max-shell:grid-cols-2 max-shell:gap-3 max-shell:p-4"
        >
          <div className="min-w-0 max-shell:col-span-2">
            <h3 className="text-base font-[550] tracking-[-0.015em] max-shell:text-[15px]">
              <Link
                href={`/meetings/${row.id}`}
                className="break-words hover:underline hover:underline-offset-4"
                data-library-link
              >
                {row.title}
              </Link>
            </h3>
            <div className="mt-1.5 flex flex-wrap gap-2 text-xs leading-[1.6] text-muted-foreground max-shell:gap-1.5">
              <LocalTime date={row.startedAt} options={{ dateStyle: 'medium' }} />
              <span aria-hidden="true" className="text-text-muted">
                ·
              </span>
              <span>
                {row.durationS === null ? tm('noRecording') : formatDuration(t, row.durationS)}
              </span>
            </div>
          </div>
          <div>
            <VisibilityBadge visibility={row.visibility} />
          </div>
          <div className="flex items-center gap-3 max-shell:justify-self-end">
            <StateBadge state={row.state} />
            {restore && <RestoreButton meetingId={row.id} title={row.title} />}
          </div>
        </li>
      ))}
    </ul>
  );
}
