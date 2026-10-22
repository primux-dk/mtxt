import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { sha256 } from './helpers';

/*
  The recorder contract against wrangler dev: the route handlers, the
  UploadSession Durable Object, R2 multipart and the queue, all local.
  Runs as the seeded colleague so the dev user's library keeps its count.
*/
const CHUNK = 8 * 1024 * 1024;
const owner = { 'x-mtxt-test-user': 'colleague' };
const stranger = { 'x-mtxt-test-user': 'newcomer' };

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
    const asAdmin = { 'x-mtxt-test-user': 'dev' };
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
    const nobody = await request.get('/api/v1/recordings/x', {
      headers: { 'x-mtxt-test-user': 'ghost' },
    });
    expect(nobody.status()).toBe(401);
  });
});
