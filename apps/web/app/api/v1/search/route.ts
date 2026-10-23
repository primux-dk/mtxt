import { HttpError } from '@/lib/http-error';
import { rest, restJson } from '@/lib/rest/handler';
import { queryMeetings, searchResults } from '@/lib/rest/meetings';
import { decodeCursor, encodeCursor, parseSearchParams } from '@/lib/rest/rules';

/*
  GET /api/v1/search?q= (docs/spec.md "API"): titles, transcripts and
  recaps of the meetings the token's user may read, best match first, with
  a snippet per meeting. The library's search, through the same scope.
*/
export async function GET(request: Request) {
  return rest(request, {}, async ({ db, installId, user }) => {
    const params = parseSearchParams(new URL(request.url).searchParams);
    if ('error' in params) throw new HttpError(400, 'invalid_request', params.error);
    const position = params.cursor ? decodeCursor(params.cursor, params.fingerprint) : undefined;
    if (position === null || (position && !('offset' in position))) {
      throw new HttpError(400, 'invalid_request', 'This cursor belongs to another query.');
    }
    const offset = position?.offset ?? 0;
    const page = await queryMeetings(db, installId, user, {
      view: 'all',
      q: params.q,
      limit: params.limit,
      offset,
      order: 'relevance',
    });
    return restJson({
      results: await searchResults(db, installId, params.q, page),
      next_cursor: page.more
        ? encodeCursor({ offset: offset + page.rows.length }, params.fingerprint)
        : null,
    });
  });
}
