'use server';

import { and, eq, ne, sql } from 'drizzle-orm';
import { foldTitle, schema, VISIBILITIES, type Visibility } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { asOwner, outcome, type ActionResult } from '@/lib/meetings/owner-action';
import { changeShare, changeVisibility } from '@/lib/meetings/sharing';
import { widens } from '@/lib/webhooks/rules';
import { queueMeetingEventQuietly } from '@/lib/webhooks/store';
import type { Colleague } from '@/lib/meetings/queries';

const u = schema.users;
const sh = schema.meetingShares;

/** Sets the visibility (lib/meetings/sharing.ts: one batch with its audit row). */
export async function setVisibility(
  meetingId: string,
  visibility: Visibility,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId, queue, meeting }) => {
      if (!VISIBILITIES.includes(visibility))
        throw new HttpError(400, 'invalid_request', 'Not a visibility.');
      const changed = await changeVisibility(db, installId, meeting, visibility);
      // Only when access widens, and only when the meeting may be sent now (lib/webhooks/rules.ts).
      if (changed === 'changed' && widens(meeting.visibility, visibility)) {
        await queueMeetingEventQuietly(
          { db, installId, queue },
          { event: 'meeting.shared', meetingId: meeting.id },
        );
      }
    }),
  );
}

/** Adds or removes a colleague (lib/meetings/sharing.ts: lands only while Shared, with its audit row). */
export async function setShare(
  meetingId: string,
  userId: string,
  shared: boolean,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId, queue, meeting }) => {
      if (shared && meeting.visibility !== 'shared')
        throw new HttpError(400, 'invalid_request', 'Set the meeting to Shared first.');
      const changed = await changeShare(db, installId, meeting, userId, shared);
      // A reader added widens access; a reader removed does not.
      if (changed === 'changed' && shared) {
        await queueMeetingEventQuietly(
          { db, installId, queue },
          { event: 'meeting.shared', meetingId: meeting.id },
        );
      }
    }),
  );
}

export type ColleagueResult =
  | {
      ok: true;
      colleagues: Colleague[];
      /** The directory holds someone besides the signed-in user (packet 12). */
      others: boolean;
      /** Colleagues in the whole directory who do not have access yet, before any search or cap. */
      addable: number;
    }
  | Extract<ActionResult, { ok: false }>;

/** The most a directory search answers with. */
const MAX_COLLEAGUES = 20;
/** Users read per search; an install's directory is a company's staff. */
const DIRECTORY_LIMIT = 5000;

/**
 * Colleagues whose name or address contains the text, for the share dialog.
 * Users of this install only, never the owner, and never someone who already
 * has access: readers leave before the cap, so 20 readers cannot fill the
 * answer while others wait unseen. The counts are over the whole directory.
 * Folded in JavaScript, since SQLite folds ASCII only and "Øster" must find
 * "øster".
 */
export async function findColleagues(meetingId: string, text: string): Promise<ColleagueResult> {
  let colleagues: Colleague[] = [];
  let others = false;
  let addable = 0;
  const result = await outcome(() =>
    asOwner(meetingId, async ({ db, installId, user }) => {
      const needle = foldTitle(text.trim()).slice(0, 100);
      const [counts] = await db
        .select({
          total: sql<number>`count(*)`,
          addable: sql<number | null>`sum(case when ${sh.userId} is null then 1 else 0 end)`,
        })
        .from(u)
        .leftJoin(
          sh,
          and(eq(sh.installId, installId), eq(sh.meetingId, meetingId), eq(sh.userId, u.id)),
        )
        .where(and(eq(u.installId, installId), ne(u.id, user.id)));
      others = Number(counts?.total ?? 0) > 0;
      addable = Number(counts?.addable ?? 0);
      const readers = new Set(
        (
          await db
            .select({ id: sh.userId })
            .from(sh)
            .where(and(eq(sh.installId, installId), eq(sh.meetingId, meetingId)))
        ).map((r) => r.id),
      );
      const all = await db
        .select({ id: u.id, name: u.name, email: u.email })
        .from(u)
        .where(and(eq(u.installId, installId), ne(u.id, user.id)))
        .orderBy(u.name, u.email)
        .limit(DIRECTORY_LIMIT);
      colleagues = all
        .filter((c) => !readers.has(c.id))
        .filter(
          (c) =>
            !needle || foldTitle(c.name).includes(needle) || foldTitle(c.email).includes(needle),
        )
        .slice(0, MAX_COLLEAGUES);
    }),
  );
  return result.ok ? { ok: true, colleagues, others, addable } : result;
}
