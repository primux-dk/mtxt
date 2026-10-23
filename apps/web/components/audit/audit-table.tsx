import { getTranslations } from 'next-intl/server';
import { LocalTime } from '@/components/local-time';
import type { AuditRow } from '@/lib/audit/queries';

/** At most this many names in a "shared" row; the rest is a count. */
const NAMES_SHOWN = 3;

/**
 * The audit log as a table (README component inventory: audit metadata is
 * a Table with semantic column headers, scrolling sideways only inside
 * itself). Time, who, what, the meeting's title and owner, and the before
 * and after of a change. Never content.
 */
export async function AuditTable({
  rows,
  names,
}: {
  rows: AuditRow[];
  names: Record<string, string>;
}) {
  const t = await getTranslations('audit');
  const tv = await getTranslations('visibility');

  const list = (ids: string[]) => {
    const shown = ids.slice(0, NAMES_SHOWN).map((id) => names[id] ?? t('details.unknownUser'));
    return ids.length > NAMES_SHOWN
      ? t('details.andMore', { names: shown.join(', '), count: ids.length - NAMES_SHOWN })
      : shown.join(', ');
  };

  const details = (row: AuditRow) => {
    const d = row.details;
    if (!d) return null;
    if (row.action === 'visibility_changed' && typeof d.before === 'string') {
      const change = t('details.visibility', {
        before: tv(d.before as 'private'),
        after: tv(d.after as 'private'),
      });
      return typeof d.sharesRemoved === 'number' && d.sharesRemoved > 0
        ? `${change} · ${t('details.sharesRemoved', { count: d.sharesRemoved })}`
        : change;
    }
    if (row.action === 'shared' && Array.isArray(d.before) && Array.isArray(d.after)) {
      const before = d.before as string[];
      const after = d.after as string[];
      const added = after.filter((id) => !before.includes(id));
      const removed = before.filter((id) => !after.includes(id));
      return [
        added.length ? t('details.added', { names: list(added) }) : null,
        removed.length ? t('details.removed', { names: list(removed) }) : null,
        t('details.readers', { count: after.length }),
      ]
        .filter(Boolean)
        .join(' · ');
    }
    return null;
  };

  const cell = 'border-b border-line-subtle px-4 py-3 align-top';
  return (
    <div
      role="region"
      aria-labelledby="audit-caption"
      tabIndex={0}
      className="overflow-x-auto rounded-card border border-border bg-card"
      data-testid="audit-table"
    >
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption id="audit-caption" className="sr-only">
          {t('table.caption')}
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            {(['time', 'user', 'action', 'meeting', 'owner', 'details'] as const).map((c) => (
              <th key={c} scope="col" className="border-b border-border px-4 py-3 font-[550]">
                {t(`table.${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="last:[&>td]:border-b-0">
              <td className={`${cell} whitespace-nowrap tabular-nums`}>
                <LocalTime date={row.at} options={{ dateStyle: 'medium', timeStyle: 'short' }} />
              </td>
              <td className={cell}>
                <span className="block font-[550]">{row.user.name}</span>
                <span className="block text-xs text-muted-foreground">{row.user.email}</span>
              </td>
              <td className={`${cell} whitespace-nowrap`}>{t(`action.${row.action}`)}</td>
              <td className={`${cell} max-w-[280px] break-words`}>
                {row.meetingTitle ?? t('table.noMeeting')}
                {row.meetingGone && row.meetingTitle && (
                  <span className="block text-xs text-muted-foreground">{t('table.gone')}</span>
                )}
              </td>
              <td className={`${cell} whitespace-nowrap`}>
                {row.owner?.name ?? t('table.noOwner')}
              </td>
              <td className={`${cell} text-muted-foreground`}>{details(row) ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
