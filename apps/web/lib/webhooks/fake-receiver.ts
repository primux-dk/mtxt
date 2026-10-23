/*
  The webhook receiver the e2e run sends its deliveries to, at
  /api/test/webhook-receiver. Same three locks as the fake providers
  (lib/stt/fake-providers.ts): a `route.e2e.ts` file, a throw on import in
  any other production bundle, and an answer only with AUTH_TEST_MODE=1 on
  localhost. The Worker reaches it only because the e2e bundle lets
  http://localhost through the address check (lib/webhooks/deps.ts).

  POST records the attempt (headers and raw body) under the delivery id and
  answers with the status the control sets; GET ?delivery=<id> gives the
  attempts back; PUT sets the status for the next ones.
*/
import { getAdapters, getEnv } from '../install';

if (process.env.NODE_ENV === 'production' && process.env.MTXT_E2E_BUILD !== '1') {
  throw new Error(
    'The fake webhook receiver is in a production bundle. Only an MTXT_E2E_BUILD=1 build may include it.',
  );
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const PREFIX = 'test/webhook-receiver';

interface Attempt {
  at: string;
  event: string | null;
  delivery: string | null;
  signature: string | null;
  contentType: string | null;
  body: string;
  answered: number;
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
const answerWith = async () =>
  (await readJson<{ status: number }>(`${PREFIX}/control.json`))?.status ?? 200;
const safeId = (id: string | null) => (id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null);

export async function fakeReceiverRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (request.method === 'PUT') {
    const { status } = (await request.json()) as { status?: number };
    const next = Number.isInteger(status) && status! >= 200 && status! <= 599 ? status! : 200;
    await writeJson(`${PREFIX}/control.json`, { status: next });
    return Response.json({ status: next });
  }
  if (request.method === 'GET') {
    const id = safeId(new URL(request.url).searchParams.get('delivery'));
    if (!id) return Response.json({ status: await answerWith() });
    const record = await readJson<Attempt[]>(`${PREFIX}/d/${id}.json`);
    return record ? Response.json(record) : notFound();
  }
  const body = await request.text();
  const id = safeId(request.headers.get('x-mtxt-delivery'));
  const status = await answerWith();
  if (id) {
    const attempts = (await readJson<Attempt[]>(`${PREFIX}/d/${id}.json`)) ?? [];
    attempts.push({
      at: new Date().toISOString(),
      event: request.headers.get('x-mtxt-event'),
      delivery: id,
      signature: request.headers.get('x-mtxt-signature'),
      contentType: request.headers.get('content-type'),
      body,
      answered: status,
    });
    await writeJson(`${PREFIX}/d/${id}.json`, attempts);
  }
  return new Response(status < 300 ? 'ok' : 'failing on purpose', { status });
}
