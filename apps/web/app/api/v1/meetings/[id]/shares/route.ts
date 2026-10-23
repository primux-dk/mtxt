import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@mtxt/adapters';
import { SHARE_MAX_BYTES } from '@/lib/chunk-guard';
import { HttpError } from '@/lib/http-error';
import { listShares } from '@/lib/meetings/queries';
import { applyShare } from '@/lib/meetings/sharing';
import { readJson } from '@/lib/recap/access';
import { rest, restJson } from '@/lib/rest/handler';
import { restMeeting } from '@/lib/rest/meetings';

/*
  POST /api/v1/meetings/{id}/shares (docs/spec.md "API"): the owner names
  a colleague as a reader, by `user_id` or by `email`, with a `read_write`
  token. The meeting must be Shared, as in the library. Adding someone who
  is already a reader changes nothing. The share is its `shared` audit row
  with `via: api`, and sends `meeting.shared`.
*/
type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return rest(request, { write: true }, async (ctx) => {
    const { db, installId, user, via } = ctx;
    const { id } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'owner');
    const body = await readJson(request, SHARE_MAX_BYTES, 'A share is at most 4 KiB.');
    const keys = Object.keys(body);
    const byId = typeof body.user_id === 'string' && keys.length === 1;
    const byEmail = typeof body.email === 'string' && keys.length === 1;
    if (!byId && !byEmail)
      throw new HttpError(400, 'invalid_request', 'Send exactly one of user_id or email.');
    const u = schema.users;
    const colleague = await db
      .select({ id: u.id })
      .from(u)
      .where(
        and(
          eq(u.installId, installId),
          byId
            ? eq(u.id, body.user_id as string)
            : sql`lower(${u.email}) = lower(${(body.email as string).trim()})`,
        ),
      )
      .get();
    if (!colleague)
      throw new HttpError(400, 'invalid_request', 'No such colleague in this install.');
    await applyShare(ctx, meeting, colleague.id, true, via);
    return restJson({ shares: await listShares(db, installId, meeting.id) });
  });
}
