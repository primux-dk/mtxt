import { HttpError } from '@/lib/http-error';
import { rest, restJson } from '@/lib/rest/handler';
import { queryMeetings, searchResults } from '@/lib/rest/meetings';
import { decodeCursor, encodeCursor, isRankPosition, parseSearchParams } from '@/lib/rest/rules';

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
    if (position === null || (position && !isRankPosition(position))) {
      throw new HttpError(400, 'invalid_request', 'This cursor belongs to another query.');
    }
    const page = await queryMeetings(db, installId, user, {
      view: 'all',
      q: params.q,
      limit: params.limit,
      afterRank: position && isRankPosition(position) ? position : undefined,
      order: 'relevance',
    });
    const last = page.rows.at(-1);
    const lastRank = last && page.ranks.get(last.id);
    return restJson({
      results: await searchResults(db, installId, params.q, page),
      next_cursor:
        page.more && last && lastRank
          ? encodeCursor(
              { ...lastRank, startedAt: new Date(last.started_at).getTime(), id: last.id },
              params.fingerprint,
            )
          : null,
    });
  });
}
