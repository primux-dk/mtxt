import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { LocalTime } from '@/components/local-time';
import { Snippet } from '@/components/search/snippet';
import type { LibraryRow } from '@/lib/meetings/queries';
import { StateBadge, VisibilityBadge } from './badges';
import { formatDuration } from './format';
import { RemoveDeleted } from './remove-deleted';
import { RestoreButton } from './restore-button';

/**
 * The one meeting list (behaviour.md rule 7): a row per meeting with title,
 * date, duration, speakers, visibility and state, per figure 02. On a phone
 * the badges move under the title. A search hit in a transcript or recap
 * shows its snippet under the row; a segment's links to its time. A meeting
 * retention has emptied is a muted row, not a link, with Remove.
 */
export async function MeetingList({ rows, restore }: { rows: LibraryRow[]; restore?: boolean }) {
  const t = await getTranslations('format');
  const tm = await getTranslations('meeting');
  const tr = await getTranslations('retention');
  const tsearch = await getTranslations('search');
  const tt = await getTranslations('transcript');
  const intl = (await getTranslations('locale'))('intl');
  const list = new Intl.ListFormat(intl, { type: 'conjunction' });
  /** "Mette, Jonas and Søren"; past three, "Mette, Jonas and 3 others" (figure 02). */
  const speakersLine = (speakers: LibraryRow['speakers']) => {
    const names = speakers.map((s) =>
      s.unnamed !== null ? tt('speaker.unnamed', { number: s.unnamed }) : s.name.split(/\s+/)[0]!,
    );
    if (names.length <= 3) return list.format(names);
    return list.format([...names.slice(0, 2), t('others', { count: names.length - 2 })]);
  };
  return (
    <ul
      className="overflow-hidden rounded-card border border-border bg-card"
      data-testid="meeting-list"
    >
      {rows.map((row) =>
        row.deletedAt ? (
          <li
            key={row.id}
            data-deleted
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line-subtle bg-muted/40 p-5 text-muted-foreground last:border-b-0 max-shell:grid-cols-1 max-shell:gap-3 max-shell:p-4"
          >
            <div className="min-w-0">
              <h3 className="text-base font-[550] tracking-[-0.015em] break-words max-shell:text-[15px]">
                {row.title}
              </h3>
              <div className="mt-1.5 flex flex-wrap gap-2 text-xs leading-[1.6]">
                <LocalTime date={row.startedAt} options={{ dateStyle: 'medium' }} />
                <span aria-hidden="true">·</span>
                <span>
                  {tr.rich('deletedRow', {
                    date: () => (
                      <LocalTime date={row.deletedAt!} options={{ dateStyle: 'medium' }} />
                    ),
                  })}
                </span>
              </div>
            </div>
            <div className="max-shell:justify-self-start">
              <RemoveDeleted meetingId={row.id} title={row.title} />
            </div>
          </li>
        ) : (
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
                {row.speakers.length > 0 && (
                  <>
                    <span aria-hidden="true" className="text-text-muted">
                      ·
                    </span>
                    <span
                      className="min-w-0 break-words"
                      title={
                        row.speakers.length > 3
                          ? list.format(row.speakers.map((s) => s.name))
                          : undefined
                      }
                    >
                      {speakersLine(row.speakers)}
                    </span>
                  </>
                )}
              </div>
              {row.snippet && (
                <p
                  data-testid="search-snippet"
                  className="mt-2 text-sm leading-[1.6] break-words text-foreground"
                >
                  <span className="mr-2 text-xs text-muted-foreground">
                    {tsearch(`kind.${row.snippet.kind}`)}
                  </span>
                  {row.snippet.kind === 'segment' && row.snippet.startS !== null ? (
                    <Link
                      href={`/meetings/${row.id}?t=${row.snippet.startS}`}
                      className="hover:underline hover:underline-offset-4"
                      data-library-link
                    >
                      <Snippet text={row.snippet.snippet} />
                    </Link>
                  ) : (
                    <Snippet text={row.snippet.snippet} />
                  )}
                </p>
              )}
            </div>
            <div>
              <VisibilityBadge visibility={row.visibility} />
            </div>
            <div className="flex items-center gap-3 max-shell:justify-self-end">
              <StateBadge state={row.state} />
              {restore && <RestoreButton meetingId={row.id} title={row.title} />}
            </div>
          </li>
        ),
      )}
    </ul>
  );
}
