import 'server-only';
import { sql } from 'drizzle-orm';
import { listTemplates, type Db, type Meeting } from '@mtxt/adapters';
import type { RecapPanelProps } from '@/components/recap/recap-panel';
import { parseRecapReason } from './llm';
import { listDecisions, listVersions, loadRecap } from './store';
import { versionView } from './view';

/** A draft with no answer after this long is offered again (its Worker may be gone). */
export const STALE_DRAFT_MS = 10 * 60_000;

type T = (key: string, values?: Record<string, string | number>) => string;

/** What the recap tab needs, for one reader of the meeting. */
export async function recapPanelData(
  db: Db,
  installId: string,
  meeting: Meeting,
  owner: boolean,
  t: T,
  now = Date.now(),
): Promise<Omit<RecapPanelProps, 'meetingId' | 'owner'>> {
  const recap = await loadRecap(db, installId, meeting.id);
  const [versions, decisions, templates, transcript] = await Promise.all([
    recap ? listVersions(db, installId, recap.id) : Promise.resolve([]),
    recap ? listDecisions(db, installId, recap.id) : Promise.resolve([]),
    owner ? listTemplates(db, installId) : Promise.resolve([]),
    db.get<{ id: string } | undefined>(sql`select t.id from transcripts t
      join recordings r on r.id = t.recording_id and r.install_id = ${installId}
      where t.install_id = ${installId} and r.meeting_id = ${meeting.id}
        and t.status = 'done' and t.is_comparison = 0
        and exists (select 1 from segments g where g.transcript_id = t.id and g.install_id = ${installId})
      limit 1`),
  ]);
  const reason = parseRecapReason(recap?.failureReason);
  return {
    recap: recap
      ? {
          id: recap.id,
          status: recap.status,
          failure: reason
            ? t(`reason.${reason.reason}`, { status: reason.status ?? 'none' })
            : null,
          stale:
            recap.status === 'drafting' &&
            (!recap.draftingSince || now - recap.draftingSince.getTime() > STALE_DRAFT_MS),
        }
      : null,
    current: recap?.current ? versionView(recap.current) : null,
    bodyMd: recap?.current?.bodyMd ?? '',
    lastAi: versions.find((v) => v.authorId === null)?.number ?? null,
    templates: templates.map((tpl) => ({ id: tpl.id, name: tpl.name })),
    templateId: meeting.templateId,
    meetingDate: meeting.startedAt.toISOString(),
    owners: decisions.map((d) => d.ownerName ?? null),
    canDraft: Boolean(transcript),
  };
}
