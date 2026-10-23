import 'server-only';
import { and, eq } from 'drizzle-orm';
import { schema, type Meeting } from '@mtxt/adapters';
import type { SessionUser } from '../auth/session';
import { HttpError } from '../http-error';
import { getAdapters } from '../install';
import { accessTo } from '../meetings/queries';

/**
 * The meeting a recap request is about, for the signed-in user: 404 when
 * they may not read it (a link is never permission), 403 when they may
 * read but the request needs the owner. Only the owner edits the recap.
 */
export async function recapMeeting(user: SessionUser, meetingId: string, need: 'read' | 'owner') {
  const ctx = await getAdapters();
  const meeting: Meeting | undefined = await ctx.db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, meetingId), eq(schema.meetings.installId, ctx.installId)),
  });
  const access = meeting ? await accessTo(ctx.db, ctx.installId, meeting, user) : null;
  if (!meeting || !access) throw new HttpError(404, 'not_found', 'No such meeting.');
  if (need === 'owner' && access !== 'owner')
    throw new HttpError(403, 'forbidden', 'Only the owner edits the recap.');
  return { ...ctx, meeting, access };
}

/** Reads a JSON body of at most `max` bytes; larger is 413, not JSON is 400. */
export async function readJson(
  request: Request,
  max: number,
  tooLarge = 'The recap is too long to save.',
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) throw new HttpError(413, 'too_large', tooLarge);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'too_large', tooLarge);
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body))
      return body as Record<string, unknown>;
  } catch {
    // Falls through to the 400.
  }
  throw new HttpError(400, 'invalid_request', 'Send a JSON object.');
}
