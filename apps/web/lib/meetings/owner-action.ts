import 'server-only';
import { and, eq } from 'drizzle-orm';
import { schema, type Meeting } from '@mtxt/adapters';
import { getSessionUser, type SessionUser } from '../auth/session';
import { HttpError } from '../http-error';
import { getAdapters } from '../install';
import { accessTo } from './queries';

/**
 * The outcome of an owner's change to a meeting. Each action sets a value
 * rather than toggling one, so a retry never doubles a change (behaviour.md
 * rule 2); the screen rolls back on `ok: false`.
 */
export type ActionResult =
  { ok: true } | { ok: false; code: 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'server' };

export type OwnerContext = Awaited<ReturnType<typeof getAdapters>> & {
  user: SessionUser;
  meeting: Meeting;
};

/**
 * Runs `run` for the meeting's owner, else throws 404 (not readable) or 403
 * (readable, not owned). `deleted` lets the owner reach a meeting retention
 * has marked deleted, which nobody can read, to remove it.
 */
export async function asOwner<T>(
  meetingId: string,
  run: (ctx: OwnerContext) => Promise<T>,
  options: { deleted?: boolean } = {},
) {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, 'unauthorized', 'Sign in first.');
  const ctx = await getAdapters();
  const m = schema.meetings;
  const meeting = await ctx.db.query.meetings.findFirst({
    where: and(eq(m.id, meetingId), eq(m.installId, ctx.installId)),
  });
  if (meeting && options.deleted && meeting.deletedAt && meeting.ownerId === user.id) {
    return run({ ...ctx, user, meeting });
  }
  const access = meeting ? await accessTo(ctx.db, ctx.installId, meeting, user) : null;
  if (!meeting || !access) throw new HttpError(404, 'not_found', 'No such meeting.');
  if (access !== 'owner')
    throw new HttpError(403, 'forbidden', 'Only the owner changes a meeting.');
  return run({ ...ctx, user, meeting });
}

/** Turns what an action threw into the ActionResult the screen understands. */
export async function outcome(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 403 || error.status === 401) return { ok: false, code: 'forbidden' };
      if (error.status === 404) return { ok: false, code: 'not_found' };
      if (error.status === 400) return { ok: false, code: 'invalid' };
      if (error.status === 409) return { ok: false, code: 'conflict' };
    }
    console.error(error);
    return { ok: false, code: 'server' };
  }
}
