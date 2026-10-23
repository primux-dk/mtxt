/*
  The fake recap model the e2e run drafts with (lib/recap/test-hooks.ts), at
  /api/test/fake-recap. Same three locks as the fake speech providers
  (lib/stt/fake-providers.ts): `route.e2e.ts` files, a throw on import in any
  other production bundle, and an answer only with AUTH_TEST_MODE=1 on
  localhost.

  It drafts deterministically from the request: the template's headings in
  order, each filled from the transcript, the decisions as a checklist with
  the speaker as owner, and a note callout. A control call makes the next
  calls fail, or answer slowly.
*/
import { getAdapters, getEnv } from '../install';

if (process.env.NODE_ENV === 'production' && process.env.MTXT_E2E_BUILD !== '1') {
  throw new Error(
    'The fake recap model is in a production bundle. Only an MTXT_E2E_BUILD=1 build may include it.',
  );
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const PREFIX = 'test/fake-recap';

type Mode = 'completed' | 'error' | 'unauthorised';
interface Control {
  mode: Mode;
  delayMs: number;
  /** Calls answered so far, for the chunking check. */
  calls: number;
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
const control = async (): Promise<Control> =>
  (await readJson<Control>(`${PREFIX}/control.json`)) ?? {
    mode: 'completed',
    delayMs: 0,
    calls: 0,
  };

/** POST: what the next calls do. GET: the control with the call count and the last request. */
export async function fakeRecapControl(request: Request) {
  if (!(await allowed(request))) return notFound();
  if (request.method === 'GET') {
    return Response.json({
      ...(await control()),
      last: await readJson(`${PREFIX}/last-request.json`),
    });
  }
  const body = (await request.json()) as Partial<Control>;
  const next: Control = {
    mode: body.mode === 'error' || body.mode === 'unauthorised' ? body.mode : 'completed',
    delayMs: Number.isInteger(body.delayMs) ? Math.min(body.delayMs!, 30_000) : 0,
    calls: 0,
  };
  await writeJson(`${PREFIX}/control.json`, next);
  return Response.json(next);
}

/** A recap from the request's template and transcript, the way a model would shape it. */
export function fakeDraft(user: string): string {
  const template = /Template:\n\n([\s\S]*?)\n\n(?:Transcript:|Summaries of)/.exec(user)?.[1] ?? '';
  const lines = user
    .split('\n')
    .filter((l) => /^[^[\s][^:]{0,60}: /.test(l) && !l.startsWith('Part '))
    .map((l) => {
      const at = l.indexOf(': ');
      return { speaker: l.slice(0, at), text: l.slice(at + 2) };
    });
  const headings = template.split('\n').filter((l) => /^#{1,4} /.test(l));
  const out: string[] = [];
  const said = (i: number) => lines[i % Math.max(1, lines.length)]?.text ?? 'Intet nævnt.';
  headings.forEach((heading, i) => {
    out.push(heading, '');
    if (/beslutning|decision/i.test(heading)) {
      lines.slice(0, 2).forEach((l) => out.push(`- [ ] ${l.text} @${l.speaker}`));
      if (!lines.length) out.push('- [ ] Ingen beslutninger (unclear)');
    } else if (i === 0) {
      out.push('> [!NOTE]', `> ${said(0)}`);
    } else out.push(said(i));
    out.push('');
  });
  return out.join('\n').trim();
}

/** The model call: `{ system, user, max_tokens }` in, `{ text, truncated }` out. */
export async function fakeRecapRoute(request: Request) {
  if (!(await allowed(request))) return notFound();
  const body = (await request.json()) as { system: string; user: string; max_tokens: number };
  const state = await control();
  await writeJson(`${PREFIX}/control.json`, { ...state, calls: state.calls + 1 });
  await writeJson(`${PREFIX}/last-request.json`, body);
  if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
  if (state.mode === 'error') return Response.json({ error: 'overloaded' }, { status: 503 });
  if (state.mode === 'unauthorised') return Response.json({ error: 'bad key' }, { status: 401 });
  // A part's summary is the part itself, cut down.
  if (body.user.startsWith('Part ')) {
    return Response.json({ text: body.user.split('\n').slice(2, 40).join('\n'), truncated: false });
  }
  return Response.json({ text: fakeDraft(body.user), truncated: false });
}
