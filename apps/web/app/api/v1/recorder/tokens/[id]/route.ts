import { revokeRecorderToken } from '@mtxt/adapters';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { getAdapters } from '@/lib/install';

/** A recorder disconnects itself, or another of the same user's recorders. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(async (user) => {
    const { db, installId } = await getAdapters();
    const result = await revokeRecorderToken(db, installId, { userId: user.id, tokenId: id });
    if (result === 'not_found') throw new HttpError(404, 'not_found', 'No such recorder.');
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  });
}
