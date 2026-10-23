import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE_BYTES } from '@mtxt/contract';
import {
  guardPath,
  limitChunkBody,
  nonCanonicalApiPath,
  RECORDER_TOKEN_MAX_BYTES,
  limitRecapBody,
  limitWebhookBody,
  RECAP_IMAGE_MAX_BYTES,
  RECAP_SAVE_MAX_BYTES,
  WEBHOOK_MAX_BYTES,
} from '../lib/chunk-guard';

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

describe('limitRecapBody', () => {
  const cases = [
    ['the recap save', 'PUT', 'http://localhost/api/v1/meetings/m1/recap', RECAP_SAVE_MAX_BYTES],
    [
      'an image upload',
      'POST',
      'http://localhost/api/v1/meetings/m1/recap/images',
      RECAP_IMAGE_MAX_BYTES,
    ],
  ] as const;
  for (const [what, method, target, max] of cases) {
    const send = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
      new Request(target, { method, body, headers, duplex: 'half' } as RequestInit);

    it(`refuses ${what} declared over ${max} bytes with 413, unread`, async () => {
      const { stream, meter } = byteBody(max + 10);
      const result = limitRecapBody(send(stream, { 'content-length': String(max + 1) }));
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(413);
      expect(((await (result as Response).json()) as { error: { code: string } }).error.code).toBe(
        'too_large',
      );
      expect(meter.provided).toBe(0);
    });

    it(`cuts ${what} with no declared length off after ${max} + 1 bytes`, async () => {
      const { stream, meter } = byteBody(2 * max);
      const guarded = limitRecapBody(send(stream));
      if (guarded instanceof Response) throw new Error('refused early');
      await expect(guarded.request.arrayBuffer()).rejects.toThrow();
      expect(guarded.overrun()).toBe(max + 1);
      expect(meter.provided).toBe(max + 1);
    });

    it(`passes ${what} at the bound whole`, async () => {
      const { stream } = byteBody(max);
      const guarded = limitRecapBody(send(stream));
      if (guarded instanceof Response) throw new Error('refused early');
      expect((await guarded.request.arrayBuffer()).byteLength).toBe(max);
    });
  }

  it('leaves the recap routes it does not bound alone', () => {
    const get = new Request('http://localhost/api/v1/meetings/m1/recap/images', {
      method: 'PUT',
      body: 'x',
    });
    expect((limitRecapBody(get) as { request: Request }).request).toBe(get);
  });
});

describe('every slash variant of a guarded route is bounded, and refused at the entry (second review)', () => {
  const routes = [
    ['the chunk upload', 'PUT', '/api/v1/recordings/r1/chunks/1', CHUNK_SIZE_BYTES, limitChunkBody],
    ['the webhook', 'POST', '/api/v1/webhooks/assemblyai', WEBHOOK_MAX_BYTES, limitWebhookBody],
    [
      'the token poll',
      'POST',
      '/api/v1/recorder/token',
      RECORDER_TOKEN_MAX_BYTES,
      limitWebhookBody,
    ],
    ['the recap save', 'PUT', '/api/v1/meetings/m1/recap', RECAP_SAVE_MAX_BYTES, limitRecapBody],
    [
      'an image upload',
      'POST',
      '/api/v1/meetings/m1/recap/images',
      RECAP_IMAGE_MAX_BYTES,
      limitRecapBody,
    ],
  ] as const;
  const variants = (path: string) => {
    const at = path.lastIndexOf('/');
    return {
      trailing: `${path}/`,
      doubled: `${path.slice(0, at)}//${path.slice(at + 1)}`,
      encoded: `${path.slice(0, at)}%2F${path.slice(at + 1)}`,
    };
  };
  for (const [what, method, path, max, guard] of routes) {
    for (const [name, variant] of Object.entries(variants(path))) {
      it(`bounds ${what} at ${name} (${variant})`, () => {
        const { stream, meter } = byteBody(max + 10);
        const request = new Request(`http://localhost${variant}`, {
          method,
          body: stream,
          headers: { 'content-length': String(max + 1) },
          duplex: 'half',
        } as RequestInit);
        const result = guard(request);
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(413);
        expect(meter.provided).toBe(0);
        expect(guardPath(new URL(request.url).pathname)).toBe(path);
        expect(nonCanonicalApiPath(new URL(request.url).pathname)).toBe(true);
      });
    }
    it(`accepts ${what} in its one canonical form`, () => {
      expect(nonCanonicalApiPath(path)).toBe(false);
    });
  }

  it('leaves pages and the root alone', () => {
    for (const path of ['/', '/meetings', '/meetings/m1', '/design/', '/settings/audit'])
      expect(nonCanonicalApiPath(path)).toBe(false);
    expect(nonCanonicalApiPath('//api/v1/recordings')).toBe(true);
  });
});
