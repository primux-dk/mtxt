'use server';

import { and, eq, ne } from 'drizzle-orm';
import { audit, foldTitle, schema, VISIBILITIES, type Visibility } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { asOwner, outcome, type ActionResult } from '@/lib/meetings/owner-action';
import type { Colleague } from '@/lib/meetings/queries';

const m = schema.meetings;
const s = schema.meetingShares;
const u = schema.users;

const shareIds = async (
  db: Parameters<Parameters<typeof asOwner>[1]>[0]['db'],
  installId: string,
  meetingId: string,
) =>
  (
    await db
      .select({ userId: s.userId })
      .from(s)
      .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)))
  )
    .map((row) => row.userId)
    .sort();

/**
 * Sets the visibility. Only the owner, and setting the value it already has
 * changes nothing and logs nothing, so a retry is harmless. Leaving `shared`
 * removes the share rows (they exist only for `shared`, docs/spec.md); the
 * audit row says how many went.
 */
export async function setVisibility(
  meetingId: string,
  visibility: Visibility,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId, user, meeting }) => {
      if (!VISIBILITIES.includes(visibility))
        throw new HttpError(400, 'invalid_request', 'Not a visibility.');
      if (meeting.visibility === visibility) return;
      const removed =
        meeting.visibility === 'shared' ? (await shareIds(db, installId, meetingId)).length : 0;
      const update = db
        .update(m)
        .set({ visibility })
        .where(and(eq(m.id, meetingId), eq(m.installId, installId)));
      if (meeting.visibility === 'shared') {
        await db.batch([
          update,
          db.delete(s).where(and(eq(s.installId, installId), eq(s.meetingId, meetingId))),
        ]);
      } else {
        await update;
      }
      await audit(db, installId, {
        userId: user.id,
        meetingId,
        meetingTitle: meeting.title,
        action: 'visibility_changed',
        details: {
          before: meeting.visibility,
          after: visibility,
          ...(removed ? { sharesRemoved: removed } : {}),
        },
      });
    }),
  );
}

/**
 * Adds a colleague to a shared meeting, or removes one. Sets a value: adding
 * someone already there, or removing someone who is not, changes nothing and
 * logs nothing. The colleague must be a user of this install and not the
 * owner; the meeting must be `shared`.
 */
export async function setShare(
  meetingId: string,
  userId: string,
  shared: boolean,
): Promise<ActionResult> {
  return outcome(() =>
    asOwner(meetingId, async ({ db, installId, user, meeting }) => {
      if (meeting.visibility !== 'shared')
        throw new HttpError(400, 'invalid_request', 'Set the meeting to Shared first.');
      if (userId === user.id)
        throw new HttpError(400, 'invalid_request', 'The owner already has it.');
      const colleague = await db.query.users.findFirst({
        where: and(eq(u.id, userId), eq(u.installId, installId)),
      });
      if (!colleague) throw new HttpError(400, 'invalid_request', 'No such colleague.');
      const before = await shareIds(db, installId, meetingId);
      if (before.includes(userId) === shared) return;
      if (shared) {
        await db.insert(s).values({ installId, meetingId, userId }).onConflictDoNothing();
      } else {
        await db
          .delete(s)
          .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId), eq(s.userId, userId)));
      }
      const after = shared ? [...before, userId].sort() : before.filter((id) => id !== userId);
      await audit(db, installId, {
        userId: user.id,
        meetingId,
        meetingTitle: meeting.title,
        action: 'shared',
        details: { before, after },
      });
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
