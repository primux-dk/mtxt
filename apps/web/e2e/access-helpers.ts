import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { sha256, wav, wrangler } from './helpers';

/** A meeting with a 3-second WAV, made through the recorder API as the user whose cookie is in `headers`. */
export async function meetingWithAudio(
  request: APIRequestContext,
  headers: Record<string, string>,
  title: string,
  startedAt = new Date(),
) {
  const audio = wav(3);
  const created = await request.post('/api/v1/recordings', {
    headers,
    data: {
      meeting: { title, started_at: startedAt.toISOString() },
      duration_s: 3,
      sha256: sha256(audio),
      size_bytes: audio.length,
      source: 'upload',
      content_type: 'audio/wav',
    },
  });
  expect(created.status()).toBe(201);
  const { id, meeting_id } = (await created.json()) as { id: string; meeting_id: string };
  await request.put(`/api/v1/recordings/${id}/chunks/1`, { headers, data: audio });
  expect((await request.post(`/api/v1/recordings/${id}/complete`, { headers })).status()).toBe(200);
  return { meetingId: meeting_id, recordingId: id };
}

export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Makes every server action fail as if the connection dropped. */
export async function dropActions(page: Page) {
  await page.route('**/*', (route) =>
    route.request().method() === 'POST' && route.request().headers()['next-action']
      ? route.abort('connectionreset')
      : route.continue(),
  );
}

/**
 * Whether the e2e run's local R2 holds an object (wrangler's own local store,
 * .wrangler/e2e). Only "the key does not exist" means no; a busy store is
 * tried again and any other failure throws, so a broken read never passes
 * for a deleted object.
 */
export function r2Has(key: string): boolean {
  try {
    wrangler([
      'r2',
      'object',
      'get',
      `mtxt-audio/${key}`,
      '--local',
      '--persist-to',
      '.wrangler/e2e',
      '--pipe',
    ]);
    return true;
  } catch (error) {
    if (/The specified key does not exist/.test(String((error as { stderr?: unknown }).stderr)))
      return false;
    throw error;
  }
}
