import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './index';

/**
 * The number of rows of another install that hang off a meeting, through any
 * foreign key: shares, recordings, speakers, recaps and audit rows on the
 * meeting; transcripts and segments under its recordings; versions and
 * decisions under its recap. The schema's foreign keys are one column, so a
 * cascade would delete them; nothing may. `meetingId` is a value or a
 * column (`sql\`m.id\``), so the count also works inside a selection.
 */
export function foreignRowsSql(installId: string, meetingId: SQL | string): SQL {
  const id = typeof meetingId === 'string' ? sql`${meetingId}` : meetingId;
  return sql`(
      (select count(*) from meeting_shares where meeting_id = ${id} and install_id != ${installId})
    + (select count(*) from recordings where meeting_id = ${id} and install_id != ${installId})
    + (select count(*) from speakers where meeting_id = ${id} and install_id != ${installId})
    + (select count(*) from recaps where meeting_id = ${id} and install_id != ${installId})
    + (select count(*) from audit_events where meeting_id = ${id} and install_id != ${installId})
    + (select count(*) from transcripts where install_id != ${installId}
        and recording_id in (select id from recordings where meeting_id = ${id}))
    + (select count(*) from segments where install_id != ${installId}
        and (transcript_id in (select t.id from transcripts t join recordings r on r.id = t.recording_id where r.meeting_id = ${id})
          or speaker_id in (select id from speakers where meeting_id = ${id})))
    + (select count(*) from recap_versions where install_id != ${installId}
        and recap_id in (select id from recaps where meeting_id = ${id}))
    + (select count(*) from decisions where install_id != ${installId}
        and recap_id in (select id from recaps where meeting_id = ${id}))
  )`;
}

export async function foreignRows(db: Db, installId: string, meetingId: string): Promise<number> {
  const [row] = await db.all<{ n: number }>(
    sql`select ${foreignRowsSql(installId, meetingId)} as n`,
  );
  return Number(row?.n ?? 0);
}
