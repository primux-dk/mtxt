import { CHUNK_SIZE_BYTES } from '@mtxt/contract';

/*
  OpenNext reads a request body to the end before a route handler runs (the
  route then sees a Content-Length even for a chunked upload). So the bound on
  a chunk body has to be set at the Worker entry, before OpenNext: a declared
  length over 8 MiB is refused unread, and any other body is cut off after
  8 MiB + 1 bytes. The route and the upload session check again.
*/
const CHUNK_PATH = /^\/api\/v1\/recordings\/[^/]+\/chunks\/[^/]+$/;

/**
 * The path every guard matches: percent-encoded slashes decoded, runs of
 * slashes collapsed, trailing slashes dropped. Next.js serves a route under
 * its slash variants too, so a guard that matched the raw path could be
 * passed by `/recap/` or `//recap` (packet 5 review). The Worker entry
 * refuses the variants themselves (`nonCanonicalApiPath`).
 */
export function guardPath(pathname: string): string {
  const path = pathname.replace(/%2f/gi, '/').replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** An `/api/` path that is not in its one accepted form: a trailing slash, `//`, or an encoded slash. */
export function nonCanonicalApiPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/') && !/^\/+api(\/|%2f)/i.test(pathname)) return false;
  return /%2f/i.test(pathname) || /\/{2,}/.test(pathname) || /.\/$/.test(pathname);
}

/** The 404 for a non-canonical API path, in the contract's error shape. */
export const nonCanonicalNotFound = () =>
  Response.json(
    { error: { code: 'not_found', message: 'No such path. Use it without a trailing slash.' } },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );

export const chunkTooLarge = () =>
  Response.json(
    { error: { code: 'too_large', message: `A chunk is at most ${CHUNK_SIZE_BYTES} bytes.` } },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  );

export interface Guarded {
  request: Request;
  /** True once the body ran past 8 MiB, with the bytes taken from the client. */
  overrun: () => number | null;
}

export function limitChunkBody(request: Request): Guarded | Response {
  const pass: Guarded = { request, overrun: () => null };
  if (request.method !== 'PUT' || !request.body) return pass;
  if (!CHUNK_PATH.test(guardPath(new URL(request.url).pathname))) return pass;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > CHUNK_SIZE_BYTES) return chunkTooLarge();
  return limitBody(request, CHUNK_SIZE_BYTES);
}

/*
  The small bodies of routes open to anyone get the same bound: the
  speech-to-text webhook (docs/decisions.md, packet 4 review) at 64 KiB,
  since AssemblyAI's body is two short fields, and the recorder's token poll
  (packet 8) at 4 KiB, a challenge and a verifier.
*/
export const WEBHOOK_PATH = '/api/v1/webhooks/assemblyai';
export const WEBHOOK_MAX_BYTES = 64 * 1024;
export const RECORDER_TOKEN_PATH = '/api/v1/recorder/token';
export const RECORDER_TOKEN_MAX_BYTES = 4 * 1024;

const SMALL_BODIES: Record<string, { max: number; what: string }> = {
  [WEBHOOK_PATH]: { max: WEBHOOK_MAX_BYTES, what: 'A webhook body' },
  [RECORDER_TOKEN_PATH]: { max: RECORDER_TOKEN_MAX_BYTES, what: 'A token request' },
};

const smallTooLarge = (path: string) => () =>
  Response.json(
    {
      error: {
        code: 'too_large',
        message: `${SMALL_BODIES[path]!.what} is at most ${SMALL_BODIES[path]!.max} bytes.`,
      },
    },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  );

export const webhookTooLarge = smallTooLarge(WEBHOOK_PATH);

/** The 413 for whichever small-body route the request was for. */
export const smallBodyTooLarge = (request: Request) =>
  smallTooLarge(guardPath(new URL(request.url).pathname))();

export function limitWebhookBody(request: Request): Guarded | Response {
  const pass: Guarded = { request, overrun: () => null };
  if (request.method !== 'POST' || !request.body) return pass;
  const path = guardPath(new URL(request.url).pathname);
  const bound = SMALL_BODIES[path];
  if (!bound) return pass;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > bound.max) return smallTooLarge(path)();
  return limitBody(request, bound.max);
}

/** The body cut off after `max` + 1 bytes; `overrun` says when it ran past. */
function limitBody(request: Request, max: number): Guarded {
  const source = request.body!;
  let byob: ReadableStreamBYOBReader | null = null;
  try {
    byob = source.getReader({ mode: 'byob' });
  } catch {
    byob = null;
  }
  const plain = byob ? null : source.getReader();
  let taken = 0;
  let over: number | null = null;
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Ask a byte stream for no more than the room left plus one byte.
      const room = max + 1 - taken;
      const { done, value } = byob
        ? await byob.read(new Uint8Array(Math.min(room, 65_536)))
        : await plain!.read();
      if (done || !value) return controller.close();
      taken += value.byteLength;
      if (taken > max) {
        over = taken;
        await (byob ?? plain)!.cancel().catch(() => {});
        return controller.error(new Error(`A body ran past ${max} bytes.`));
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return (byob ?? plain)!.cancel(reason);
    },
  });
  return {
    request: new Request(request, { body: limited, duplex: 'half' } as RequestInit),
    overrun: () => over,
  };
}

/*
  The recap's two bodies (packet 5 review): the editor's save, JSON with the
  markdown, at 512 KiB, and an image upload at 8 MiB. Bounded here for the
  same reason as a chunk: OpenNext buffers the body before the route runs.
*/
export const RECAP_SAVE_MAX_BYTES = 512 * 1024;
export const RECAP_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const RECAP_SAVE_PATH = /^\/api\/v1\/meetings\/[^/]+\/recap$/;
const RECAP_IMAGE_PATH = /^\/api\/v1\/meetings\/[^/]+\/recap\/images$/;

function recapBound(request: Request) {
  const path = guardPath(new URL(request.url).pathname);
  if (request.method === 'PUT' && RECAP_SAVE_PATH.test(path))
    return { max: RECAP_SAVE_MAX_BYTES, what: 'A recap save' };
  if (request.method === 'POST' && RECAP_IMAGE_PATH.test(path))
    return { max: RECAP_IMAGE_MAX_BYTES, what: 'An image' };
  return null;
}

/** The 413 for a recap save or image upload, in the API's error shape. */
export const recapTooLarge = (request: Request) => {
  const bound = recapBound(request);
  return Response.json(
    {
      error: {
        code: 'too_large',
        message: `${bound?.what ?? 'The body'} is at most ${bound?.max ?? 0} bytes.`,
      },
    },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  );
};

export function limitRecapBody(request: Request): Guarded | Response {
  const pass: Guarded = { request, overrun: () => null };
  if (!request.body) return pass;
  const bound = recapBound(request);
  if (!bound) return pass;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > bound.max) return recapTooLarge(request);
  return limitBody(request, bound.max);
}

/*
  A webhook's signed export link (lib/webhooks/grant.ts) is open to anyone
  with the token, so its route is held to one shape at the Worker entry,
  before OpenNext reads anything: exactly `/api/v1/export/<token>`, one
  segment, GET or HEAD, and no body at all. Any other path under it is 404,
  any other method 405, and a request that carries a body is refused unread
  (packet 13 review).
*/
export const EXPORT_PATH = /^\/api\/v1\/export\/[^/]+$/;

export function exportGuard(request: Request): Response | null {
  const path = guardPath(new URL(request.url).pathname);
  if (path !== '/api/v1/export' && !path.startsWith('/api/v1/export/')) return null;
  const refuse = (status: number, code: string, message: string, headers = {}) =>
    Response.json(
      { error: { code, message } },
      { status, headers: { 'cache-control': 'no-store', ...headers } },
    );
  if (!EXPORT_PATH.test(path)) return refuse(404, 'not_found', 'No such export.');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse(405, 'method_not_allowed', 'An export link takes GET.', { allow: 'GET, HEAD' });
  }
  const length = request.headers.get('content-length');
  if ((length !== null && length !== '0') || request.headers.has('transfer-encoding')) {
    return refuse(400, 'invalid_request', 'An export link takes no body.');
  }
  return null;
}
