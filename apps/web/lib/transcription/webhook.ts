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

  let body: { transcript_id?: unknown; status?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: { code: 'invalid_request', message: 'Send JSON.' } });
  }
  if (typeof body.transcript_id !== 'string' || !body.transcript_id) {
    return json(400, { error: { code: 'invalid_request', message: 'transcript_id is missing.' } });
  }

  const t = schema.transcripts;
  const transcript = await deps.db.query.transcripts.findFirst({
    where: and(
      eq(t.installId, deps.installId),
      eq(t.provider, 'assemblyai'),
      eq(t.providerJobId, body.transcript_id),
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
