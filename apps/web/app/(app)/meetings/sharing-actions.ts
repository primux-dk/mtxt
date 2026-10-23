'use server';

import { and, eq, ne } from 'drizzle-orm';
import { foldTitle, schema, VISIBILITIES, type Visibility } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { asOwner, outcome, type ActionResult } from '@/lib/meetings/owner-action';
import { changeShare, changeVisibility } from '@/lib/meetings/sharing';
import type { Colleague } from '@/lib/meetings/queries';

const u = schema.users;

/** Sets the visibility (lib/meetings/sharing.ts: one batch with its audit row). */
export async function setVisibility(
  meetingId: string,
  visibility: Visibility,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId, meeting }) => {
      if (!VISIBILITIES.includes(visibility))
        throw new HttpError(400, 'invalid_request', 'Not a visibility.');
      await changeVisibility(db, installId, meeting, visibility);
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
    asOwner(meetingId, async ({ db, installId, meeting }) => {
      if (shared && meeting.visibility !== 'shared')
        throw new HttpError(400, 'invalid_request', 'Set the meeting to Shared first.');
      await changeShare(db, installId, meeting, userId, shared);
    }),
  );
}

export type ColleagueResult =
  { ok: true; colleagues: Colleague[] } | Extract<ActionResult, { ok: false }>;

/** The most a directory search answers with. */
const MAX_COLLEAGUES = 20;
/** Users read per search; an install's directory is a company's staff. */
const DIRECTORY_LIMIT = 5000;

/**
 * Colleagues whose name or address contains the text, for the share dialog.
 * Users of this install only, never the owner. Folded in JavaScript, since
 * SQLite folds ASCII only and "Øster" must find "øster".
 */
export async function findColleagues(meetingId: string, text: string): Promise<ColleagueResult> {
  let colleagues: Colleague[] = [];
  const result = await outcome(() =>
    asOwner(meetingId, async ({ db, installId, user }) => {
      const needle = foldTitle(text.trim()).slice(0, 100);
      const all = await db
        .select({ id: u.id, name: u.name, email: u.email })
        .from(u)
        .where(and(eq(u.installId, installId), ne(u.id, user.id)))
        .orderBy(u.name, u.email)
        .limit(DIRECTORY_LIMIT);
      colleagues = (
        needle
          ? all.filter(
              (c) => foldTitle(c.name).includes(needle) || foldTitle(c.email).includes(needle),
            )
          : all
      ).slice(0, MAX_COLLEAGUES);
    }),
  );
  return result.ok ? { ok: true, colleagues } : result;
}
