import { getFormatter, getTranslations } from 'next-intl/server';

/**
 * The retention announcement in the meeting header (behaviour.md rule 3):
 * "Deleted on 2026-11-30 · Keep". Packet 6 computes `deleteAt` and adds the
 * Keep shortcut; until then the page passes null and nothing renders.
 */
export async function RetentionNotice({ deleteAt }: { deleteAt: Date | null }) {
  if (!deleteAt) return null;
  const t = await getTranslations('meeting.retention');
  const format = await getFormatter();
  return (
    <p className="text-sm text-destructive">
      {t('deleteOn', { date: format.dateTime(deleteAt, { dateStyle: 'long' }) })}
    </p>
  );
}
