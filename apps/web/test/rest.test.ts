import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_RATE_LIMIT,
  createApiToken,
  hashRecorderToken,
  newRecorderToken,
  type ApiTokenScope,
} from '@mtxt/adapters';
import {
  authorise,
  decodeCursor,
  encodeCursor,
  etagFor,
  etagMatches,
  parseIsoTime,
  parseListParams,
  parseSearchParams,
  queryFingerprint,
} from '../lib/rest/rules';
import { transcriptText } from '../lib/webhooks/transcript';
import { INSTALL, testDb } from '@mtxt/adapters/test/sqlite';

/*
  Packet 16: the REST API's rules (scope, cursors, ETags, strict queries),
  then the handler and the routes on a real database with the request
  headers, the session and the adapters mocked: a token's scope, the rate
  limit, ETag and 304, pages through the cursor, and the permission scope.
*/
const state = vi.hoisted(() => ({
  headers: new Headers(),
  sessionUserId: null as string | null,
  db: null as unknown,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => state.headers }));
vi.mock('@/lib/auth', () => ({
  auth: async () => (state.sessionUserId ? { user: { id: state.sessionUserId } } : null),
}));
const queued = vi.hoisted(() => [] as unknown[]);
vi.mock('@/lib/install', () => ({
  getAdapters: async () => ({
    db: state.db,
    installId: INSTALL,
    queue: { send: async (job: unknown) => void queued.push(job) },
    storage: {},
  }),
}));

const { rest, restJson } = await import('../lib/rest/handler');
const { snippetParts } = await import('../lib/rest/meetings');
const meetingsRoute = await import('../app/api/v1/meetings/route');
const meetingRoute = await import('../app/api/v1/meetings/[id]/route');
const searchRoute = await import('../app/api/v1/search/route');
const transcriptRoute = await import('../app/api/v1/meetings/[id]/transcript/route');
const sharesRoute = await import('../app/api/v1/meetings/[id]/shares/route');
const shareRoute = await import('../app/api/v1/meetings/[id]/shares/[userId]/route');

describe('authorise', () => {
  const api = (scope: ApiTokenScope) => ({ kind: 'api' as const, scope });
  const recorder = { kind: 'recorder' as const, scope: null };

  it('lets a read token read and refuses it a write', () => {
    expect(authorise(api('read'), { write: false, session: false })).toEqual({ ok: true });
    expect(authorise(api('read'), { write: true, session: false })).toMatchObject({
      ok: false,
      status: 403,
      code: 'insufficient_scope',
    });
    expect(authorise(api('read_write'), { write: true, session: false })).toEqual({ ok: true });
  });

  it("refuses a recorder's token, and the session except where the library calls", () => {
    expect(authorise(recorder, { write: false, session: true })).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(authorise(undefined, { write: false, session: false })).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(authorise(undefined, { write: true, session: true })).toEqual({ ok: true });
  });
});

describe('cursors', () => {
  const f = queryFingerprint({ view: 'all', q: undefined });

  it('round-trip both keysets, opaque and URL-safe', () => {
    const keyset = encodeCursor({ startedAt: 1_792_000_000_000, id: 'm-ø-1' }, f);
    expect(keyset).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(keyset, f)).toEqual({ startedAt: 1_792_000_000_000, id: 'm-ø-1' });
    const ranked = { rank: 2, hits: 3, startedAt: 1_792_000_000_000, id: 'm2' };
    expect(decodeCursor(encodeCursor(ranked, f), f)).toEqual(ranked);
  });

  it('are refused by another query, and when tampered with', () => {
    const cursor = encodeCursor({ rank: 1, hits: 1, startedAt: 5, id: 'm1' }, f);
    expect(decodeCursor(cursor, queryFingerprint({ view: 'mine', q: undefined }))).toBeNull();
    expect(decodeCursor(cursor.slice(0, -2), f)).toBeNull();
    expect(decodeCursor('not a cursor!', f)).toBeNull();
    const forged = btoa(JSON.stringify({ v: 1, f, k: -5, h: 1, s: 5, i: 'm1' })).replace(/=+$/, '');
    expect(decodeCursor(forged, f)).toBeNull();
  });

  it('bind a query by its filters, whatever their order', () => {
    expect(queryFingerprint({ a: '1', b: 2 })).toBe(queryFingerprint({ b: 2, a: '1' }));
    expect(queryFingerprint({ a: '1' })).not.toBe(queryFingerprint({ a: '2' }));
  });
});

describe('ETags', () => {
  it('are strong, the same for the same bytes, and differ otherwise', async () => {
    const a = await etagFor(new TextEncoder().encode('{"a":1}'));
    expect(a).toMatch(/^"[A-Za-z0-9_-]{22}"$/);
    expect(await etagFor(new TextEncoder().encode('{"a":1}'))).toBe(a);
    expect(await etagFor(new TextEncoder().encode('{"a":2}'))).not.toBe(a);
  });

  it('match If-None-Match as RFC 9110 says: a list, W/, or *', () => {
    expect(etagMatches('"x"', '"x"')).toBe(true);
    expect(etagMatches('"y", W/"x"', '"x"')).toBe(true);
    expect(etagMatches('*', '"x"')).toBe(true);
    expect(etagMatches('"y"', '"x"')).toBe(false);
    expect(etagMatches(null, '"x"')).toBe(false);
  });
});

describe('query parameters', () => {
  it('default the list to every readable meeting, 50 a page', () => {
    expect(parseListParams(new URLSearchParams())).toMatchObject({ view: 'all', limit: 50 });
  });

  it('name an unknown or wrong parameter instead of ignoring it', () => {
    const error = (q: string) =>
      (parseListParams(new URLSearchParams(q)) as { error: string }).error;
    expect(error('page=2')).toBe('Unknown parameter "page".');
    expect(error('view=everything')).toMatch(/^view is one of/);
    expect(error('status=done')).toMatch(/^status is one of/);
    expect(error('since=yesterday')).toMatch(/^since is an ISO 8601 time/);
    expect(error('limit=0')).toMatch(/^limit is/);
    expect(error('limit=101')).toMatch(/^limit is/);
    expect(error('view=all&view=mine')).toBe('"view" is given more than once.');
    expect(parseListParams(new URLSearchParams('since=2026-10-01'))).toMatchObject({
      since: new Date('2026-10-01T00:00:00Z'),
    });
    // Calendar fields are checked, not rolled over into the next month.
    for (const bad of [
      '2026-02-31',
      '2026-02-30T00:00:00Z',
      '2026-02-29',
      '2026-13-01',
      '2026-10-01T24:00:00Z',
      '2026-10-01T10:60Z',
      '2026-10-01T10:00:61Z',
      '2026-10-01T10:00:00+24:00',
    ]) {
      expect(error(`since=${encodeURIComponent(bad)}`), bad).toMatch(/^since is an ISO 8601 time/);
    }
    expect(parseIsoTime('2028-02-29')).toEqual(new Date('2028-02-29T00:00:00Z'));
    expect(parseIsoTime('2026-10-01T10:30+02:00')).toEqual(new Date('2026-10-01T08:30:00Z'));
    expect(parseIsoTime('2026-10-01T10:30:15.123456Z')).toEqual(
      new Date('2026-10-01T10:30:15.123Z'),
    );
    expect('error' in parseSearchParams(new URLSearchParams('q='))).toBe(true);
  });
});

describe('snippets and plain text', () => {
  it('turn the index marks into parts, never markup', () => {
    expect(snippetParts('…om \u0002budget\u0003 for <b>2027\u0003')).toEqual([
      { text: '…om ', hit: false },
      { text: 'budget', hit: true },
      { text: ' for <b>2027', hit: false },
    ]);
  });

  it('write a transcript as one line per segment with the time and the name', () => {
    expect(
      transcriptText({
        meeting_id: 'm',
        language: 'da',
        speakers: [{ id: 's1', name: 'Anne Holm' }],
        segments: [
          { start_ms: 0, end_ms: 1000, speaker_id: 's1', text: 'Godmorgen.' },
          { start_ms: 3_725_000, end_ms: 3_726_000, speaker_id: null, text: 'To\nlinjer' },
        ],
      }),
    ).toBe('[0:00:00] Anne Holm: Godmorgen.\n[1:02:05] To linjer\n');
  });
});

describe('the REST API on a database', () => {
  let ctx: { db: ReturnType<typeof testDb>['db']; raw: ReturnType<typeof testDb>['sqlite'] };

  async function token(userId: string, scope: ApiTokenScope = 'read') {
    const value = newRecorderToken();
    await createApiToken(ctx.db, INSTALL, {
      userId,
      name: 'Alex',
      scope,
      tokenHash: await hashRecorderToken(value),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return value;
  }
  const as = (value: string, extra: Record<string, string> = {}) => {
    state.headers = new Headers({ authorization: `Bearer ${value}`, ...extra });
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${path}`, { headers });
  const audits = () =>
    ctx.raw
      .prepare(`select action, user_id, meeting_id, details from audit_events order by at, rowid`)
      .all() as { action: string; user_id: string; meeting_id: string | null; details: string }[];

  beforeEach(async () => {
    const fresh = testDb();
    ctx = { db: fresh.db, raw: fresh.sqlite };
    state.db = ctx.db;
    state.headers = new Headers();
    state.sessionUserId = null;
    queued.length = 0;
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES
      ('mette', '${INSTALL}', 'm', 'mette@example.com', 'Mette Lund', 1),
      ('anne', '${INSTALL}', 'a', 'anne@example.com', 'Anne Holm', 0),
      ('jonas', '${INSTALL}', 'j', 'jonas@example.com', 'Jonas Skov', 0)`);
    const meeting = (id: string, owner: string, visibility: string, startedAt: number) =>
      ctx.raw
        .exec(`INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility)
        VALUES ('${id}', '${INSTALL}', '${owner}', 'Møde ${id}', 'møde ${id}', ${startedAt}, '${visibility}')`);
    // Anne's own five, Jonas's company one and his shared one with Anne; Jonas's private one and Mette's.
    for (let i = 1; i <= 5; i++) meeting(`a${i}`, 'anne', 'private', Date.UTC(2026, 9, i));
    meeting('jc', 'jonas', 'company', Date.UTC(2026, 9, 6));
    meeting('js', 'jonas', 'shared', Date.UTC(2026, 9, 7));
    meeting('jp', 'jonas', 'private', Date.UTC(2026, 9, 8));
    meeting('mp', 'mette', 'private', Date.UTC(2026, 9, 9));
    // Two meetings start at the same moment: the cursor still pages them apart.
    meeting('a6', 'anne', 'private', Date.UTC(2026, 9, 1));
    ctx.raw.exec(
      `INSERT INTO meeting_shares (install_id, meeting_id, user_id) VALUES ('${INSTALL}', 'js', 'anne')`,
    );
  });

  it("lists what the token's user may read, a page at a time, and nothing else", async () => {
    as(await token('anne'));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await meetingsRoute.GET(
        get(`/api/v1/meetings?limit=3${cursor ? `&cursor=${cursor}` : ''}`),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        meetings: { id: string; access: string }[];
        next_cursor: string | null;
      };
      seen.push(...body.meetings.map((m) => m.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    // Newest first, ties by id; Jonas's private meeting and Mette's are not there.
    expect(seen).toEqual(['js', 'jc', 'a5', 'a4', 'a3', 'a2', 'a1', 'a6']);
    // A list writes no audit row.
    expect(audits().filter((a) => a.action !== 'api_token_created')).toEqual([]);
  });

  it('gives an admin nothing extra', async () => {
    as(await token('mette'));
    const body = (await (await meetingsRoute.GET(get('/api/v1/meetings'))).json()) as {
      meetings: { id: string }[];
    };
    expect(body.meetings.map((m) => m.id)).toEqual(['mp', 'jc']);
    const other = await meetingRoute.GET(get('/api/v1/meetings/a1'), {
      params: Promise.resolve({ id: 'a1' }),
    });
    expect(other.status).toBe(404);
  });

  it('pages a search by its order, so a match added between pages repeats nothing', async () => {
    as(await token('anne'));
    const page = async (cursor?: string) =>
      (await (
        await searchRoute.GET(
          get(`/api/v1/search?q=m%C3%B8de&limit=2${cursor ? `&cursor=${cursor}` : ''}`),
        )
      ).json()) as { results: { meeting: { id: string } }[]; next_cursor: string | null };
    const first = await page();
    expect(first.results.map((r) => r.meeting.id)).toEqual(['js', 'jc']);
    // A newer matching meeting lands before the cursor's place: page two neither repeats jc nor skips a5.
    ctx.raw
      .exec(`INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility)
      VALUES ('new', '${INSTALL}', 'anne', 'Møde ny', 'møde ny', ${Date.UTC(2026, 9, 30)}, 'private')`);
    const seen = first.results.map((r) => r.meeting.id);
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await page(cursor);
      seen.push(...next.results.map((r) => r.meeting.id));
      cursor = next.next_cursor;
    }
    expect(seen).toEqual(['js', 'jc', 'a5', 'a4', 'a3', 'a2', 'a1', 'a6']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a cursor from another query', async () => {
    as(await token('anne'));
    const first = (await (await meetingsRoute.GET(get('/api/v1/meetings?limit=1'))).json()) as {
      next_cursor: string;
    };
    const response = await meetingsRoute.GET(
      get(`/api/v1/meetings?view=mine&limit=1&cursor=${first.next_cursor}`),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('answers 304 to its own ETag and audits only the read it served', async () => {
    as(await token('anne'));
    const params = { params: Promise.resolve({ id: 'js' }) };
    const first = await meetingRoute.GET(get('/api/v1/meetings/js'), params);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"/);
    expect(first.headers.get('x-ratelimit-limit')).toBe('60');
    const again = await meetingRoute.GET(get('/api/v1/meetings/js', { 'if-none-match': etag }), {
      params: Promise.resolve({ id: 'js' }),
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    const opened = audits().filter((a) => a.action === 'opened');
    expect(opened).toEqual([
      {
        action: 'opened',
        user_id: 'anne',
        meeting_id: 'js',
        details: '{"via":"api","token":"Alex"}',
      },
    ]);
  });

  it('refuses a write with a read token, and a reader a write with any token', async () => {
    as(await token('anne', 'read'));
    const patch = (id: string, body: unknown) =>
      meetingRoute.PATCH(
        new Request(`http://localhost/api/v1/meetings/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    const scoped = await patch('a1', { keep: true });
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
    as(await token('anne', 'read_write'));
    expect((await patch('js', { keep: true })).status).toBe(403);
    expect((await patch('jp', { keep: true })).status).toBe(404);
    expect((await patch('a1', { colour: 'red' })).status).toBe(400);
    const done = await patch('a1', { title: '  Ny titel ', visibility: 'company', keep: true });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({
      title: 'Ny titel',
      visibility: 'company',
      keep: true,
    });
    const changed = audits().find((a) => a.action === 'visibility_changed')!;
    expect(JSON.parse(changed.details)).toEqual({
      before: 'private',
      after: 'company',
      via: 'api',
      token: 'Alex',
    });
  });

  it("refuses a recorder's token and lets the 61st request of a minute wait", async () => {
    ctx.raw
      .exec(`insert into recorder_tokens (id, install_id, user_id, device_name, token_hash, created_at, expires_at)
      values ('rec', '${INSTALL}', 'anne', 'Mac', '${await hashRecorderToken('mtxt_' + 'r'.repeat(43))}', 0, ${Date.now() + 86_400_000})`);
    as('mtxt_' + 'r'.repeat(43));
    const refused = await meetingsRoute.GET(get('/api/v1/meetings'));
    expect(refused.status).toBe(403);
    as(await token('anne'));
    for (let i = 0; i < API_RATE_LIMIT; i++) {
      expect((await searchRoute.GET(get('/api/v1/search?q=m%C3%B8de'))).status).toBe(200);
    }
    const limited = await meetingsRoute.GET(get('/api/v1/meetings'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({
      error: { code: 'rate_limited' },
      retry_after: expect.any(Number),
    });
  });

  it('counts a refused write against the minute, with the rate headers on the 403', async () => {
    as(await token('anne', 'read'));
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      const response = await meetingRoute.PATCH(
        new Request('http://localhost/api/v1/meetings/a1', {
          method: 'PATCH',
          body: JSON.stringify({ keep: true }),
        }),
        { params: Promise.resolve({ id: 'a1' }) },
      );
      statuses.push(response.status);
      expect(response.headers.get('x-ratelimit-limit'), `request ${i + 1}`).toBe('60');
      expect(response.headers.get('x-ratelimit-remaining'), `request ${i + 1}`).toBe(
        String(Math.max(0, 59 - i)),
      );
      if (response.status === 429) expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    }
    expect(statuses).toEqual([...Array(60).fill(403), ...Array(5).fill(429)]);
    const [row] = ctx.raw
      .prepare(`select rate_count from recorder_tokens where kind = 'api'`)
      .all() as { rate_count: number }[];
    expect(row!.rate_count).toBe(60);
  });

  it("answers an unknown colleague and another install's user with the same 404", async () => {
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES
      ('elsewhere', 'other-install', 'e', 'karen@example.com', 'Karen Holt')`);
    ctx.raw.exec(`UPDATE meetings SET visibility = 'shared' WHERE id = 'a1'`);
    as(await token('anne', 'read_write'));
    const add = async (body: unknown) => {
      const response = await sharesRoute.POST(
        new Request('http://localhost/api/v1/meetings/a1/shares', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: 'a1' }) },
      );
      return { status: response.status, body: await response.json() };
    };
    const unknown = await add({ email: 'nobody@example.com' });
    const foreign = await add({ email: 'karen@example.com' });
    const foreignId = await add({ user_id: 'elsewhere' });
    expect(unknown).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'No such colleague in this install.' } },
    });
    expect(foreign).toEqual(unknown);
    expect(foreignId).toEqual(unknown);
    const removed = await shareRoute.DELETE(
      new Request('http://localhost/api/v1/meetings/a1/shares/elsewhere', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'a1', userId: 'elsewhere' }) },
    );
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual(unknown.body);
    // A colleague of this install by address, whatever its case.
    expect(await add({ email: 'JONAS@example.com' })).toMatchObject({ status: 200 });
  });

  it('is 401 without a token, and with a revoked one', async () => {
    expect((await meetingsRoute.GET(get('/api/v1/meetings'))).status).toBe(401);
    const value = await token('anne');
    ctx.raw.exec(`update recorder_tokens set revoked_at = 1 where kind = 'api'`);
    as(value);
    expect((await meetingsRoute.GET(get('/api/v1/meetings'))).status).toBe(401);
  });

  it('says a meeting has no transcript yet with 404, and writes no row for it', async () => {
    as(await token('anne'));
    const response = await transcriptRoute.GET(get('/api/v1/meetings/a1/transcript'), {
      params: Promise.resolve({ id: 'a1' }),
    });
    expect(response.status).toBe(404);
    expect(audits().filter((a) => a.action === 'exported')).toEqual([]);
  });

  it('runs a write handler with the session only where asked, and never caches a write', async () => {
    state.sessionUserId = 'anne';
    const handler = vi.fn(async () => restJson({ ok: true }));
    const refused = await rest(get('/x'), {}, handler);
    expect(refused.status).toBe(401);
    const allowed = await rest(
      new Request('http://localhost/x', { method: 'PUT' }),
      { write: true, session: true },
      handler,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('etag')).toBeNull();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
