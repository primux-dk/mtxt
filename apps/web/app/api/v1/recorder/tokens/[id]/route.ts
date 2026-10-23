import { revokeRecorderToken } from '@mtxt/adapters';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { getAdapters } from '@/lib/install';

/**
 * A recorder disconnects itself. With a bearer token, only the token the
 * call authenticated with: a recorder never revokes a sibling, so a stolen
 * token cannot sign the user's other devices out. With the library's session
 * cookie, any of the user's own tokens, as the Recorders dialog does.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(async (user) => {
    if (user.recorderTokenId !== undefined && user.recorderTokenId !== id) {
      throw new HttpError(404, 'not_found', 'A recorder disconnects only its own token.');
    }
    const { db, installId } = await getAdapters();
    const result = await revokeRecorderToken(db, installId, { userId: user.id, tokenId: id });
    if (result === 'not_found') throw new HttpError(404, 'not_found', 'No such recorder.');
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  });
}
