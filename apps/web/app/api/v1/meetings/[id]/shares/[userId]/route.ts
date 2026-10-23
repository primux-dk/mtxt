import { applyShare } from '@/lib/meetings/sharing';
import { rest } from '@/lib/rest/handler';
import { restMeeting } from '@/lib/rest/meetings';

/*
  DELETE /api/v1/meetings/{id}/shares/{userId} (docs/spec.md "API"): the
  owner removes a reader, with a `read_write` token. Removing someone who
  is not a reader changes nothing and is 204 too. The removal is its
  `shared` audit row with `via: api`; it sends no webhook event, since
  access narrowed.
*/
type Params = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(request: Request, { params }: Params) {
  return rest(request, { write: true }, async (ctx) => {
    const { db, installId, user, via } = ctx;
    const { id, userId } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'owner');
    await applyShare(ctx, meeting, userId, false, via);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  });
}
