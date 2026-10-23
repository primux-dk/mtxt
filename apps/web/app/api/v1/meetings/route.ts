import { HttpError } from '@/lib/http-error';
import { rest, restJson } from '@/lib/rest/handler';
import { queryMeetings } from '@/lib/rest/meetings';
import { decodeCursor, encodeCursor, isRankPosition, parseListParams } from '@/lib/rest/rules';

/*
  GET /api/v1/meetings (docs/spec.md "API"): the meetings the token's user
  may read, newest first, a page at a time. Metadata only, so a list writes
  no audit row, as the library's does not.
*/
export async function GET(request: Request) {
  return rest(request, {}, async ({ db, installId, user }) => {
    const params = parseListParams(new URL(request.url).searchParams);
    if ('error' in params) throw new HttpError(400, 'invalid_request', params.error);
    const position = params.cursor ? decodeCursor(params.cursor, params.fingerprint) : undefined;
    if (position === null || (position && isRankPosition(position))) {
      throw new HttpError(400, 'invalid_request', 'This cursor belongs to another query.');
    }
    const page = await queryMeetings(db, installId, user, {
      view: params.view,
      q: params.q,
      status: params.status,
      since: params.since,
      limit: params.limit,
      after: position,
      order: 'date',
    });
    const last = page.rows.at(-1);
    return restJson({
      meetings: page.rows,
      next_cursor:
        page.more && last
          ? encodeCursor(
              { startedAt: new Date(last.started_at).getTime(), id: last.id },
              params.fingerprint,
            )
          : null,
    });
  });
}
