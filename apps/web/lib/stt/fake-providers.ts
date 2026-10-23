/*
  The fake AssemblyAI, fake ElevenLabs and fake Workers AI the e2e run talks to (see
  lib/stt/test-hooks.ts). Same three locks as the test sign-in
  (lib/auth/test-sign-in.ts): the routes are `route.e2e.ts` files, a route
  only in an MTXT_E2E_BUILD=1 build; this module throws on import in any
  other production bundle; and every handler answers only with
  AUTH_TEST_MODE=1 on localhost.

  The fake AssemblyAI keeps its jobs in the install's storage under
  `test/fake-assemblyai/`, answers a submit at once, and posts the webhook
  back after a short delay with the fixture: three speakers, Danish. A
  control call sets what the next job does: complete, fail, or find no speech.
  The fake ElevenLabs answers its one multipart request with a two-speaker
  Danish fixture, under the same control.
*/
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getAdapters, getEnv } from '../install';
import { ASSEMBLYAI_WEBHOOK_HEADER, type AaiTranscript } from './assemblyai';
import fixture from './fixtures/assemblyai-3-speakers.json';
import scribeFixture from './fixtures/elevenlabs-2-speakers.json';
import whisperFixture from './fixtures/whisper.json';

if (process.env.NODE_ENV === 'production' && process.env.MTXT_E2E_BUILD !== '1') {
  throw new Error(
    'The fake speech-to-text providers are in a production bundle. Only an MTXT_E2E_BUILD=1 build may include them.',
  );
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const PREFIX = 'test/fake-assemblyai';
const SCRIBE_PREFIX = 'test/fake-elevenlabs';

export type FakeMode = 'completed' | 'error' | 'empty' | 'malformed';
interface Control {
  mode: FakeMode;
  delayMs: number;
}
interface FakeJob {
  id: string;
  status: 'queued' | 'completed' | 'error';
  mode: FakeMode;
  request: Record<string, unknown>;
}

async function allowed(request: Request) {
  const env = await getEnv();
  return env.AUTH_TEST_MODE === '1' && LOCAL.has(new URL(request.url).hostname);
}
const notFound = () => new Response('Not found', { status: 404 });

async function readJson<T>(key: string): Promise<T | null> {
  const { storage } = await getAdapters();
  const object = await storage.get(key);
  return object ? ((await new Response(object.body).json()) as T) : null;
}
async function writeJson(key: string, value: unknown) {
  const { storage } = await getAdapters();
  await storage.put(key, JSON.stringify(value), { contentType: 'application/json' });
}

const control = async () =>
  (await readJson<Control>(`${PREFIX}/control.json`)) ?? { mode: 'completed', delayMs: 1500 };

/** POST: set what the next job does. GET: the last transcript request, for assertions. */
export async function controlRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (request.method === 'GET') {
    return Response.json((await readJson(`${PREFIX}/last-request.json`)) ?? {});
  }
  const body = (await request.json()) as Partial<Control>;
  const next: Control = {
    mode:
      body.mode === 'error' || body.mode === 'empty' || body.mode === 'malformed'
        ? body.mode
        : 'completed',
    delayMs: Number.isInteger(body.delayMs) ? Math.min(body.delayMs!, 30_000) : 1500,
  };
  await writeJson(`${PREFIX}/control.json`, next);
  return Response.json(next);
}

export async function uploadRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (!request.headers.get('authorization'))
    return Response.json({ error: 'no key' }, { status: 401 });
  const bytes = (await request.arrayBuffer()).byteLength;
  // A broken answer that echoes the key, for the redaction check (e2e/transcript.spec.ts).
  if ((await control()).mode === 'malformed') {
    return new Response(`{"upload_url": ${request.headers.get('authorization')} <html>`, {
      status: 200,
    });
  }
  return Response.json({
    upload_url: `https://fake.invalid/upload/${crypto.randomUUID()}?bytes=${bytes}`,
  });
}

function transcriptFor(job: FakeJob): AaiTranscript {
  if (job.status === 'queued') return { id: job.id, status: 'processing' };
  if (job.status === 'error') {
    return { id: job.id, status: 'error', error: 'Fake AssemblyAI could not decode the audio.' };
  }
  if (job.mode === 'empty') {
    return { ...fixture, id: job.id, text: '', words: [], utterances: [] } as AaiTranscript;
  }
  return { ...fixture, id: job.id } as AaiTranscript;
}

export async function submitRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (!request.headers.get('authorization'))
    return Response.json({ error: 'no key' }, { status: 401 });
  const body = (await request.json()) as Record<string, unknown>;
  const { mode, delayMs } = await control();
  const job: FakeJob = { id: `fake-${crypto.randomUUID()}`, status: 'queued', mode, request: body };
  await writeJson(`${PREFIX}/jobs/${job.id}.json`, job);
  // The secret is the test's own placeholder; the request is kept for assertions without it.
  await writeJson(`${PREFIX}/last-request.json`, { ...body, webhook_auth_header_value: '[set]' });

  const { ctx } = await getCloudflareContext({ async: true });
  ctx.waitUntil(
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await writeJson(`${PREFIX}/jobs/${job.id}.json`, {
        ...job,
        status: mode === 'error' ? 'error' : 'completed',
      });
      await fetch(String(body.webhook_url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [String(body.webhook_auth_header_name ?? ASSEMBLYAI_WEBHOOK_HEADER)]: String(
            body.webhook_auth_header_value ?? '',
          ),
        },
        body: JSON.stringify({
          transcript_id: job.id,
          status: mode === 'error' ? 'error' : 'completed',
        }),
      }).catch((error) => console.error('fake AssemblyAI: webhook failed', error));
    })(),
  );
  return Response.json({ id: job.id, status: 'queued' });
}

export async function transcriptRoute(request: Request, id: string) {
  if (!(await allowed(request))) return notFound();
  const job = await readJson<FakeJob>(`${PREFIX}/jobs/${id}.json`);
  if (!job) return Response.json({ error: 'Transcript not found' }, { status: 404 });
  return Response.json(transcriptFor(job));
}

/** Workers AI Whisper: the fixture, or an error when the test asked for one. */
export async function whisperRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  const { mode } = await control();
  if (mode === 'error') return Response.json({ error: 'capacity' }, { status: 500 });
  if (mode === 'empty') return Response.json({ text: '', segments: [] });
  return Response.json(whisperFixture);
}

/** GET: the last Scribe request, for assertions. POST: the shared control. */
export async function elevenLabsControlRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (request.method === 'GET') {
    return Response.json((await readJson(`${SCRIBE_PREFIX}/last-request.json`)) ?? {});
  }
  return controlRoute(request);
}

/**
 * ElevenLabs Scribe: one multipart POST, answered at once. A failure echoes
 * the key in its body, so the e2e run can check it never reaches a log or a row.
 */
export async function elevenLabsRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  const key = request.headers.get('xi-api-key');
  if (!key) return Response.json({ detail: { status: 'invalid_api_key' } }, { status: 401 });
  const form = await request.formData();
  const file = form.get('file');
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of form) {
    if (name === 'file' || typeof value !== 'string') continue;
    if (name === 'keyterms') fields.keyterms = [...((fields.keyterms as string[]) ?? []), value];
    else fields[name] = value;
  }
  await writeJson(`${SCRIBE_PREFIX}/last-request.json`, {
    ...fields,
    file:
      file && typeof file !== 'string'
        ? { bytes: file.size, type: file.type, name: file.name }
        : null,
    contentLength: request.headers.get('content-length'),
  });
  const { mode } = await control();
  if (mode === 'error') {
    return Response.json(
      {
        detail: {
          status: 'invalid_audio',
          message: `Fake ElevenLabs could not decode the audio for ${key}.`,
        },
      },
      { status: 422 },
    );
  }
  if (mode === 'malformed') return new Response(`{"words": ${key} <html>`, { status: 200 });
  if (mode === 'empty') return Response.json({ ...scribeFixture, text: '', words: [] });
  return Response.json(scribeFixture);
}
