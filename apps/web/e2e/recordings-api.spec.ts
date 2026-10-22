import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { checkFetch, test } from './contract';
import { sha256, SESSION_HEADERS, signInHeaders } from './helpers';

test.beforeAll(async ({ baseURL }) => signInHeaders(baseURL!));

/*
  The recorder contract against wrangler dev: the route handlers, the
  UploadSession Durable Object, R2 multipart and the queue, all local.
  Runs as the seeded colleague so the dev user's library keeps its count.
*/
const CHUNK = 8 * 1024 * 1024;
const owner = SESSION_HEADERS.colleague;
const stranger = SESSION_HEADERS.newcomer;

const file = new Uint8Array(randomBytes(2 * CHUNK + 1234));

const chunk = (bytes: Uint8Array, n: number) =>
  Buffer.from(bytes.subarray((n - 1) * CHUNK, n * CHUNK));

async function create(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post('/api/v1/recordings', {
    headers: owner,
    data: {
      meeting: { title: 'API test', started_at: '2026-10-22T09:00:00Z' },
      duration_s: 60,
      source: 'upload',
      content_type: 'audio/webm',
      ...body,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; meeting_id: string; chunk_count: number | null };
}

const put = (request: APIRequestContext, id: string, n: number, data: Buffer, headers = owner) =>
  request.put(`/api/v1/recordings/${id}/chunks/${n}`, { headers, data });

test.describe('recordings API', () => {
  test('three chunks out of order, then confirmed, then transcribing, with the whole file in R2', async ({
    request,
  }) => {
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    expect(rec.chunk_count).toBe(3);
    for (const n of [3, 1, 2]) {
      const receipt = await put(request, rec.id, n, chunk(file, n));
      expect(receipt.status()).toBe(200);
    }
    const before = await (
      await request.get(`/api/v1/recordings/${rec.id}`, { headers: owner })
    ).json();
    expect(before).toMatchObject({
      status: 'uploading',
      chunks_received: [1, 2, 3],
      chunk_count: 3,
    });

    const complete = await request.post(`/api/v1/recordings/${rec.id}/complete`, {
      headers: owner,
    });
    expect(complete.status()).toBe(200);
    const confirmed = await complete.json();
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmed_at).toBeTruthy();

    const after = await (
      await request.get(`/api/v1/recordings/${rec.id}`, { headers: owner })
    ).json();
    expect(after).toMatchObject({ status: 'transcribing', chunks_received: [] });

    // The object in R2, through the authorised audio route.
    const audio = await request.get(`/api/v1/recordings/${rec.id}/audio`, {
      headers: { ...owner, range: 'bytes=0-0' },
    });
    expect(audio.status()).toBe(206);
    expect(audio.headers()['content-range']).toBe(`bytes 0-0/${file.length}`);
    expect(audio.headers()).toMatchObject({
      'content-type': 'audio/webm',
      'x-content-type-options': 'nosniff',
    });
    expect(audio.headers()['content-disposition']).toBe('inline; filename="recording.webm"');
    // An empty Range header is refused by keepEmptyRange when it reaches the Worker.
    // Local workerd strips it before Worker code runs (has('range') is false), so it
    // cannot be seen end to end here; test/http-range.test.ts covers the guard.
    for (const range of ['bytes=abc-def', 'bytes=-', 'bytes=0-1,5-6']) {
      const bad = await request.get(`/api/v1/recordings/${rec.id}/audio`, {
        headers: { ...owner, range },
      });
      expect(bad.status(), range).toBe(416);
      expect(bad.headers()['content-range']).toBe(`bytes */${file.length}`);
    }

    // A second complete answers the same confirmation.
    const again = await request.post(`/api/v1/recordings/${rec.id}/complete`, { headers: owner });
    expect(again.status()).toBe(200);
    expect((await again.json()).confirmed_at).toBe(confirmed.confirmed_at);
  });

  test('a wrong sha256 fails the recording and deletes the file', async ({ request }) => {
    const small = new Uint8Array(randomBytes(5000));
    const rec = await create(request, { sha256: 'f'.repeat(64), size_bytes: small.length });
    expect((await put(request, rec.id, 1, Buffer.from(small))).status()).toBe(200);
    const complete = await request.post(`/api/v1/recordings/${rec.id}/complete`, {
      headers: owner,
    });
    expect(complete.status()).toBe(422);
    expect((await complete.json()).error.code).toBe('hash_mismatch');
    const status = await (
      await request.get(`/api/v1/recordings/${rec.id}`, { headers: owner })
    ).json();
    expect(status).toMatchObject({ status: 'failed', error: { code: 'hash_mismatch' } });
    expect(
      (await request.get(`/api/v1/recordings/${rec.id}/audio`, { headers: owner })).status(),
    ).toBe(404);
    // And it stays failed: the recorder starts again with a new create.
    expect((await put(request, rec.id, 1, Buffer.from(small))).status()).toBe(409);
  });

  test('lists missing chunks at complete', async ({ request }) => {
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    await put(request, rec.id, 1, chunk(file, 1));
    const complete = await request.post(`/api/v1/recordings/${rec.id}/complete`, {
      headers: owner,
    });
    expect(complete.status()).toBe(409);
    expect(await complete.json()).toMatchObject({
      error: { code: 'missing_chunks' },
      missing: [2, 3],
    });
  });

  test('refuses a chunk of the wrong size', async ({ request }) => {
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    const response = await put(request, rec.id, 1, Buffer.alloc(100));
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('chunk_size');
  });

  test('a recording made while uploading gets its size and hash at complete', async ({
    request,
  }) => {
    const rec = await create(request, { source: 'browser', duration_s: 0 });
    expect(rec.chunk_count).toBeNull();
    for (const n of [1, 2, 3]) await put(request, rec.id, n, chunk(file, n));
    const complete = await request.post(`/api/v1/recordings/${rec.id}/complete`, {
      headers: owner,
      data: { sha256: sha256(file), size_bytes: file.length, duration_s: 42 },
    });
    expect(complete.status()).toBe(200);
    expect(await complete.json()).toMatchObject({
      status: 'confirmed',
      duration_s: 42,
      size_bytes: file.length,
    });
  });

  test('only the owner uploads; others cannot see a private recording', async ({ request }) => {
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    expect((await put(request, rec.id, 1, chunk(file, 1), stranger)).status()).toBe(403);
    expect(
      (await request.post(`/api/v1/recordings/${rec.id}/complete`, { headers: stranger })).status(),
    ).toBe(403);
    expect(
      (await request.get(`/api/v1/recordings/${rec.id}`, { headers: stranger })).status(),
    ).toBe(404);
    // Uploading into someone else's meeting is refused too.
    const into = await request.post('/api/v1/recordings', {
      headers: stranger,
      data: {
        meeting_id: rec.meeting_id,
        duration_s: 1,
        source: 'upload',
        content_type: 'audio/webm',
      },
    });
    expect(into.status()).toBe(404);
  });

  test('an admin gets no special read access to a private meeting', async ({ request }) => {
    // `dev` is the seeded admin; the colleague's meeting is private.
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    const asAdmin = SESSION_HEADERS.dev;
    expect((await request.get(`/api/v1/recordings/${rec.id}`, { headers: asAdmin })).status()).toBe(
      404,
    );
    expect((await request.get(`/meetings/${rec.meeting_id}`, { headers: asAdmin })).status()).toBe(
      404,
    );
  });

  test('answers errors in the contract shape and refuses without a login', async ({ request }) => {
    const bad = await request.post('/api/v1/recordings', {
      headers: owner,
      data: { meeting_id: 'x', meeting: {} },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_request');
    const big = await request.post('/api/v1/recordings', {
      headers: owner,
      data: {
        meeting_id: 'x',
        duration_s: 1,
        source: 'upload',
        content_type: 'audio/webm',
        sha256: 'a'.repeat(64),
        size_bytes: 3 * 1024 ** 3,
      },
    });
    expect(big.status()).toBe(413);
    // Only audio or video types: the audio route sends it back as Content-Type.
    const html = await request.post('/api/v1/recordings', {
      headers: owner,
      data: {
        meeting: { title: 'x', started_at: '2026-10-22T09:00:00Z' },
        duration_s: 1,
        source: 'upload',
        content_type: 'text/html',
      },
    });
    expect(html.status()).toBe(400);
    const nobody = await request.get('/api/v1/recordings/x', {
      headers: {},
    });
    expect(nobody.status()).toBe(401);
  });

  test('a chunk must be application/octet-stream', async ({ request }) => {
    const rec = await create(request, { sha256: sha256(file), size_bytes: file.length });
    const response = await request.put(`/api/v1/recordings/${rec.id}/chunks/1`, {
      headers: { ...owner, 'content-type': 'text/html' },
      data: chunk(file, 1),
    });
    expect(response.status()).toBe(415);
    expect((await response.json()).error.code).toBe('unsupported_media_type');
  });

  test('stops reading a chunk without Content-Length at one byte past 8 MiB', async ({
    request,
    baseURL,
  }) => {
    const rec = await create(request, { source: 'browser', duration_s: 0 });
    // 16 MiB, sent chunked so the server cannot refuse it by its header.
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= 2 * CHUNK) return controller.close();
          sent += 65_536;
          controller.enqueue(new Uint8Array(65_536));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await fetch(`${baseURL}/api/v1/recordings/${rec.id}/chunks/1`, {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit);
    await checkFetch('PUT', response);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('too_large');
    const after = await (
      await request.get(`/api/v1/recordings/${rec.id}`, { headers: owner })
    ).json();
    expect(after.chunks_received).toEqual([]);
  });

  test('a declared Content-Length over 8 MiB is refused before reading', async ({
    request,
    baseURL,
  }) => {
    const rec = await create(request, { source: 'browser', duration_s: 0 });
    const response = await fetch(`${baseURL}/api/v1/recordings/${rec.id}/chunks/1`, {
      method: 'PUT',
      headers: { ...owner, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(CHUNK + 1),
    });
    await checkFetch('PUT', response);
    expect(response.status).toBe(413);
  });

  test('60 MiB out of order, eight PUTs at a time: busy with Retry-After, then confirmed', async ({
    request,
  }) => {
    const big = new Uint8Array(randomBytes(60 * 1024 * 1024));
    const rec = await create(request, { sha256: sha256(big), size_bytes: big.length });
    const pending = new Set([8, 3, 1, 7, 2, 6, 4, 5]);
    let busy = 0;
    while (pending.size) {
      const wave = [...pending];
      const responses = await Promise.all(wave.map((n) => put(request, rec.id, n, chunk(big, n))));
      responses.forEach((response, i) => {
        if (response.status() === 200) return pending.delete(wave[i]!);
        expect(response.status()).toBe(409);
        expect(response.headers()['retry-after']).toBe('1');
        busy++;
      });
    }
    expect(busy).toBeGreaterThan(0);
    const complete = await request.post(`/api/v1/recordings/${rec.id}/complete`, {
      headers: owner,
    });
    expect(complete.status()).toBe(200);
    expect(await complete.json()).toMatchObject({ status: 'confirmed', size_bytes: big.length });
  });
});
