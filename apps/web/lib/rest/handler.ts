import 'server-only';
import { API_RATE_LIMIT, takeApiRequest, type ViaApi } from '@mtxt/adapters';
import { getApiUser, type SessionUser } from '../auth/session';
import { HttpError } from '../http-error';
import { getAdapters } from '../install';
import { authorise, etagFor, etagMatches } from './rules';

/*
  Every REST API route runs through rest() (docs/spec.md "API"): the
  caller and its token, the scope, the per-token rate limit, the contract's
  error shape, and on a GET the ETag and its 304. An API token's request is
  counted before its scope is checked, and every answer, an error too,
  carries the rate headers. A read is audited only
  when its body is served: the route hands its audit row to `served`, which
  runs after the 304 check and before the answer leaves, so a 304 writes
  nothing and a body is never served without its row.
*/

export type RestContext = Awaited<ReturnType<typeof getAdapters>> & {
  user: SessionUser;
  /** `via: 'api'` and the token's name, for audit rows; null for the library's own session. */
  via: ViaApi | null;
  /** Runs `write` when the response's body is served (not on a 304, not on an error). */
  served: (write: () => Promise<unknown>) => void;
};

const NO_STORE = { 'cache-control': 'no-store' };

/** The contract's error shape: `{ error: { code, message } }`, plus what the error carries. */
export function restError(error: unknown, headers: Record<string, string> = {}): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message }, ...error.extra },
      { status: error.status, headers: { ...NO_STORE, ...headers, ...error.headers } },
    );
  }
  console.error('REST API call failed:', (error as Error)?.name ?? 'unknown');
  return Response.json(
    { error: { code: 'internal', message: 'Something went wrong on the server.' } },
    { status: 500, headers: { ...NO_STORE, ...headers } },
  );
}

/** JSON for a REST answer. GETs may be revalidated with their ETag; nothing is stored by a shared cache. */
export const restJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'private, no-cache' } });

export async function rest(
  request: Request,
  need: { write?: boolean; session?: boolean },
  handler: (ctx: RestContext) => Promise<Response>,
): Promise<Response> {
  let limits: Record<string, string> = {};
  try {
    const user = await getApiUser();
    if (!user) {
      throw new HttpError(
        401,
        'unauthorized',
        'Send a working personal API token as Authorization: Bearer <token>.',
      );
    }
    // Every request with an API token counts, a refused one included, so a
    // script that keeps hitting a 403 is still held to its minute.
    const adapters = await getAdapters();
    if (user.token?.kind === 'api') {
      const taken = await takeApiRequest(adapters.db, adapters.installId, user.token.id);
      limits = {
        'x-ratelimit-limit': String(API_RATE_LIMIT),
        'x-ratelimit-remaining': String(taken.remaining),
      };
      if (!taken.ok) {
        throw new HttpError(
          429,
          'rate_limited',
          `At most ${API_RATE_LIMIT} requests a minute per token. Wait ${taken.retryAfter} s.`,
          { retry_after: taken.retryAfter },
          { 'retry-after': String(taken.retryAfter) },
        );
      }
    }
    const verdict = authorise(user.token, {
      write: need.write ?? false,
      session: need.session ?? false,
    });
    if (!verdict.ok) throw new HttpError(verdict.status, verdict.code, verdict.message);

    const writes: (() => Promise<unknown>)[] = [];
    const via: ViaApi | null = user.token ? { via: 'api', token: user.token.name } : null;
    const response = await handler({ ...adapters, user, via, served: (w) => writes.push(w) });

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(limits)) headers.set(k, v);
    if (request.method !== 'GET' || response.status !== 200) {
      for (const write of writes) await write();
      return new Response(response.body, { status: response.status, headers });
    }
    const bytes = await response.arrayBuffer();
    // Over the bytes sent; a Word file packs to the same bytes for the same version (lib/recap/docx.ts).
    const etag = await etagFor(bytes);
    headers.set('etag', etag);
    if (etagMatches(request.headers.get('if-none-match'), etag)) {
      headers.delete('content-type');
      headers.delete('content-disposition');
      return new Response(null, { status: 304, headers });
    }
    for (const write of writes) await write();
    return new Response(bytes, { status: 200, headers });
  } catch (error) {
    return restError(error, limits);
  }
}
