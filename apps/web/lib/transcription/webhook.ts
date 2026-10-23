/*
  AssemblyAI's webhook (docs/decisions.md, packet 4). AssemblyAI posts
  `{ transcript_id, status }` with the install's secret in a custom header.
  A wrong or missing secret is 401. A transcript id this install does not
  know, or one already finished, is acknowledged and ignored, so a replay
  changes nothing. A pending one wakes the transcribe job, which fetches
  the result itself: the webhook body is never trusted for content.
*/
import { and, eq } from 'drizzle-orm';
import { open, schema, type Db, type QueueAdapter } from '@mtxt/adapters';
import { WEBHOOK_MAX_BYTES } from '../chunk-guard';
import { ASSEMBLYAI_WEBHOOK_HEADER } from '../stt/assemblyai';
import { webhookWakes } from './state';

export interface WebhookDeps {
  db: Db;
  installId: string;
  queue: QueueAdapter;
  settingsKey: string | undefined;
  /** The sealed secret from the settings row, or null when none was made yet. */
  sealedSecret: string | null;
}

const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** Equal-time comparison: both sides are hashed first, so length leaks nothing either. */
export async function secretMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0 && given.length > 0;
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** AssemblyAI's webhook body: an object with a transcript id of at most 128 characters and a known status. */
export function parseWebhook(body: unknown): { transcriptId: string; status: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { transcript_id: id, status } = body as Record<string, unknown>;
  if (typeof id !== 'string' || id.length < 1 || id.length > 128) return null;
  if (status !== 'completed' && status !== 'error') return null;
  return { transcriptId: id, status };
}

export async function assemblyAiWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const given = request.headers.get(ASSEMBLYAI_WEBHOOK_HEADER) ?? '';
  let expected: string | null = null;
  if (deps.sealedSecret && deps.settingsKey) {
    try {
      expected = await open(deps.sealedSecret, 'settings.webhook_secret', deps.settingsKey);
    } catch {
      expected = null;
    }
  }
  if (!expected || !(await secretMatches(given, expected))) {
    return json(401, { error: { code: 'unauthorized', message: 'Wrong webhook secret.' } });
  }

  // Only now, with the secret checked, is the body read; the Worker entry caps it at 64 KiB.
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > WEBHOOK_MAX_BYTES) {
      return json(413, { error: { code: 'too_large', message: 'The body is too large.' } });
    }
    body = JSON.parse(text);
  } catch {
    return json(400, { error: { code: 'invalid_request', message: 'Send JSON.' } });
  }
  const parsed = parseWebhook(body);
  if (!parsed) {
    return json(400, {
      error: { code: 'invalid_request', message: 'Send transcript_id and status.' },
    });
  }
  const t = schema.transcripts;
  const transcript = await deps.db.query.transcripts.findFirst({
    where: and(
      eq(t.installId, deps.installId),
      eq(t.provider, 'assemblyai'),
      eq(t.providerJobId, parsed.transcriptId),
    ),
  });
  if (!webhookWakes(transcript)) return json(200, { ok: true, ignored: true });
  await deps.queue.send({
    type: 'transcribe',
    recording_id: transcript!.recordingId,
    install_id: deps.installId,
  });
  return json(200, { ok: true });
}
