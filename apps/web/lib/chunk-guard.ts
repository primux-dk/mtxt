import { CHUNK_SIZE_BYTES } from '@mtxt/contract';

/*
  OpenNext reads a request body to the end before a route handler runs (the
  route then sees a Content-Length even for a chunked upload). So the bound on
  a chunk body has to be set at the Worker entry, before OpenNext: a declared
  length over 8 MiB is refused unread, and any other body is cut off after
  8 MiB + 1 bytes. The route and the upload session check again.
*/
const CHUNK_PATH = /^\/api\/v1\/recordings\/[^/]+\/chunks\/[^/]+$/;

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
  if (!CHUNK_PATH.test(new URL(request.url).pathname)) return pass;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > CHUNK_SIZE_BYTES) return chunkTooLarge();
  return limitBody(request, CHUNK_SIZE_BYTES);
}

/*
  The speech-to-text webhook (docs/decisions.md, packet 4 review) gets the
  same bound, at 64 KiB: AssemblyAI's body is two short fields, and the
  route is open to anyone who knows the address.
*/
export const WEBHOOK_PATH = '/api/v1/webhooks/assemblyai';
export const WEBHOOK_MAX_BYTES = 64 * 1024;

export const webhookTooLarge = () =>
  Response.json(
    {
      error: {
        code: 'too_large',
        message: `A webhook body is at most ${WEBHOOK_MAX_BYTES} bytes.`,
      },
    },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  );

export function limitWebhookBody(request: Request): Guarded | Response {
  const pass: Guarded = { request, overrun: () => null };
  if (request.method !== 'POST' || !request.body) return pass;
  if (new URL(request.url).pathname !== WEBHOOK_PATH) return pass;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > WEBHOOK_MAX_BYTES) return webhookTooLarge();
  return limitBody(request, WEBHOOK_MAX_BYTES);
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
