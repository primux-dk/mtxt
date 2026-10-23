import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE_BYTES } from '@mtxt/contract';
import { limitChunkBody, limitWebhookBody, WEBHOOK_MAX_BYTES } from '../lib/chunk-guard';

/** A byte stream of `total` bytes that counts what it hands over, as workerd gives a body. */
function byteBody(total: number) {
  const meter = { provided: 0 };
  const stream = new ReadableStream<Uint8Array>({
    type: 'bytes',
    pull(controller) {
      const request = (controller as ReadableByteStreamController).byobRequest!;
      if (meter.provided >= total) {
        controller.close();
        request.respond(0);
        return;
      }
      const view = request.view!;
      const n = Math.min(view.byteLength, total - meter.provided);
      meter.provided += n;
      request.respond(n);
    },
  });
  return { stream, meter };
}

const url = 'http://localhost/api/v1/recordings/r1/chunks/1';
const put = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'PUT', body, headers, duplex: 'half' } as RequestInit);

describe('limitChunkBody', () => {
  it('refuses a declared length over 8 MiB without reading a byte', () => {
    const { stream, meter } = byteBody(CHUNK_SIZE_BYTES + 1);
    const result = limitChunkBody(put(stream, { 'content-length': String(CHUNK_SIZE_BYTES + 1) }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(meter.provided).toBe(0);
  });

  it('cuts a chunked 16 MiB body off after exactly 8 MiB + 1 bytes', async () => {
    const { stream, meter } = byteBody(2 * CHUNK_SIZE_BYTES);
    const guarded = limitChunkBody(put(stream));
    if (guarded instanceof Response) throw new Error('refused early');
    await expect(guarded.request.arrayBuffer()).rejects.toThrow();
    expect(guarded.overrun()).toBe(CHUNK_SIZE_BYTES + 1);
    expect(meter.provided).toBe(CHUNK_SIZE_BYTES + 1);
  });

  it('passes an 8 MiB body through whole', async () => {
    const { stream } = byteBody(CHUNK_SIZE_BYTES);
    const guarded = limitChunkBody(put(stream));
    if (guarded instanceof Response) throw new Error('refused early');
    expect((await guarded.request.arrayBuffer()).byteLength).toBe(CHUNK_SIZE_BYTES);
    expect(guarded.overrun()).toBeNull();
  });

  it('leaves every other request alone', () => {
    const other = new Request('http://localhost/api/v1/recordings', { method: 'POST', body: 'x' });
    const result = limitChunkBody(other);
    expect(result).not.toBeInstanceOf(Response);
    expect((result as { request: Request }).request).toBe(other);
  });
});

describe('limitWebhookBody', () => {
  const hook = 'http://localhost/api/v1/webhooks/assemblyai';
  const post = (body: ReadableStream<Uint8Array> | string, headers: Record<string, string> = {}) =>
    new Request(hook, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

  it('refuses a declared length over 64 KiB with 413, unread', async () => {
    const { stream, meter } = byteBody(WEBHOOK_MAX_BYTES + 10);
    const result = limitWebhookBody(
      post(stream, { 'content-length': String(WEBHOOK_MAX_BYTES + 1) }),
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(meter.provided).toBe(0);
  });

  it('reads at most 64 KiB + 1 of a 9 MiB body with no declared length', async () => {
    const { stream, meter } = byteBody(9 * 1024 * 1024);
    const guarded = limitWebhookBody(post(stream));
    if (guarded instanceof Response) throw new Error('refused early');
    await expect(guarded.request.arrayBuffer()).rejects.toThrow();
    expect(guarded.overrun()).toBeGreaterThan(WEBHOOK_MAX_BYTES);
    expect(meter.provided).toBeLessThanOrEqual(WEBHOOK_MAX_BYTES + 1);
  });

  it('passes a small body whole', async () => {
    const guarded = limitWebhookBody(post('{"transcript_id":"a","status":"completed"}'));
    if (guarded instanceof Response) throw new Error('refused');
    expect(await guarded.request.text()).toBe('{"transcript_id":"a","status":"completed"}');
    expect(guarded.overrun()).toBeNull();
  });
});
