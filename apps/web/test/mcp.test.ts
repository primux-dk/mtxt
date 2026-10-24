import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countMcpConnections,
  createOAuthCode,
  findRecorderUser,
  hashRecorderToken,
  MAX_MCP_CONNECTIONS,
  MCP_ACCESS_LIFETIME_MS,
  newRecorderToken,
  redeemOAuthCode,
  refreshMcpToken,
  revokeMcpToken,
  s256,
  type ApiTokenScope,
} from '@mtxt/adapters';
import {
  authorizationServerMetadata,
  checkAuthorize,
  protectedResourceMetadata,
  readClient,
  readRegistration,
  redirectUriAllowed,
  redirectUriMatches,
  redirectWith,
  requestedScope,
  resourceAllowed,
  signClient,
} from '../lib/mcp/oauth';
import { runTool, TOOL_NAMES, TOOLS, type RestRequest } from '../lib/mcp/tools';
import { authorise } from '../lib/rest/rules';
import { INSTALL, testDb } from '@mtxt/adapters/test/sqlite';

/*
  Packet 17: the MCP server. Its OAuth rules (registration, the client id,
  the authorization request), the connection's rows (code, tokens,
  refresh, revoke), the tool mapping onto the REST API, and the whole
  server through /mcp on a real database: each tool runs the REST API's
  own route handler with the connection's user and scope, and writes the
  API's audit rows with `via: mcp`.
*/
const state = vi.hoisted(() => ({
  headers: new Headers(),
  db: null as unknown,
  mcpEnabled: true,
}));
const KEY = vi.hoisted(() => btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => state.headers }));
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/install', () => ({
  getAdapters: async () => ({
    db: state.db,
    installId: INSTALL,
    queue: { send: async () => {} },
    storage: {},
  }),
  getInstallSettings: async () => ({ productName: 'Acme Meetings', mcpEnabled: state.mcpEnabled }),
  getEnv: async () => ({ SETTINGS_KEY: KEY }),
}));

const mcpRoute = await import('../app/mcp/route');
const tokenRoute = await import('../app/oauth/token/route');
const registerRoute = await import('../app/oauth/register/route');
const meetingsRoute = await import('../app/api/v1/meetings/route');

const ORIGIN = 'https://meetings.example.com';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('the OAuth rules', () => {
  it('take https, http on loopback and an app scheme as redirect URIs, and nothing else', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost:6274/oauth/callback',
      'http://127.0.0.1:33418/callback',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
      'com.example.app:/callback',
      'myapp:/callback',
    ])
      expect(redirectUriAllowed(ok), ok).toBe(true);
    for (const bad of [
      'http://example.com/callback',
      'https://example.com/cb#frag',
      'https://user:pw@example.com/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'JavaScript:alert(1)',
      'vbscript:x',
      `https://example.com/${'a'.repeat(600)}`,
      42,
    ])
      expect(redirectUriAllowed(bad), String(bad)).toBe(false);
  });

  it('match a redirect URI exactly, except a loopback port', () => {
    const registered = ['http://127.0.0.1:1/callback', 'https://claude.ai/cb'];
    expect(redirectUriMatches(registered, 'http://127.0.0.1:55123/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:55123/other')).toBe(false);
    expect(redirectUriMatches(registered, 'https://claude.ai/cb')).toBe(true);
    expect(redirectUriMatches(registered, 'https://claude.ai/cb?x=1')).toBe(false);
  });

  it('sign a client id that names its registration, and refuse any change or another key', async () => {
    const client = { name: 'Claude', redirectUris: ['https://claude.ai/cb'] };
    const id = await signClient(KEY, client);
    expect(id).toMatch(/^mcp1\./);
    expect(await readClient(KEY, id)).toEqual(client);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
    expect(await readClient(other, id)).toBeNull();
    const [, body, sig] = id.split('.');
    const forged = btoa(JSON.stringify({ n: 'Claude', r: ['https://evil.example/cb'] }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(await readClient(KEY, `mcp1.${forged}.${sig}`)).toBeNull();
    expect(await readClient(KEY, `mcp1.${body}.${sig!.slice(0, -1)}A`)).toBeNull();
    expect(await readClient(KEY, 'not-a-client')).toBeNull();
  });

  it('register public clients, named by the client or by their redirect host', () => {
    expect(readRegistration({ redirect_uris: ['https://chatgpt.com/cb'] })).toEqual({
      ok: true,
      client: { name: 'chatgpt.com', redirectUris: ['https://chatgpt.com/cb'] },
    });
    expect(
      readRegistration({
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost:1/cb'],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    ).toMatchObject({ ok: true, client: { name: 'Claude Code' } });
    expect(readRegistration({ redirect_uris: [] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
    expect(readRegistration({ redirect_uris: ['http://evil.example/cb'] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
    expect(
      readRegistration({
        redirect_uris: ['https://a.example/cb'],
        grant_types: ['client_credentials'],
      }),
    ).toMatchObject({ error: 'invalid_client_metadata' });
    expect(readRegistration([1])).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('read the scope, and the resource only when it is this server', () => {
    expect(requestedScope(undefined)).toBe('read');
    expect(requestedScope('read read_write')).toBe('read_write');
    expect(requestedScope('admin')).toBeNull();
    expect(resourceAllowed(`${ORIGIN}/mcp`, ORIGIN)).toBe(true);
    expect(resourceAllowed(`${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(resourceAllowed('https://other.example/mcp', ORIGIN)).toBe(false);
  });

  it('describe the server: the protected resource and its authorization server', () => {
    expect(protectedResourceMetadata(ORIGIN, 'Acme Meetings')).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['read', 'read_write'],
    });
    expect(authorizationServerMetadata(ORIGIN)).toMatchObject({
      issuer: ORIGIN,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('show a bad client or redirect URI on the page, and send every other error back', async () => {
    const clientId = await signClient(KEY, {
      name: 'Claude',
      redirectUris: ['https://claude.ai/cb'],
    });
    const ask = (q: Record<string, string>) => checkAuthorize(KEY, new URLSearchParams(q), ORIGIN);
    const good = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/cb',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${ORIGIN}/mcp`,
    };
    expect(await ask(good)).toMatchObject({ ok: true, request: { scope: 'read', state: 'xyz' } });
    expect(await ask({ ...good, client_id: 'mcp1.x.y' })).toEqual({
      ok: false,
      redirect: false,
      reason: 'client',
    });
    expect(await ask({ ...good, redirect_uri: 'https://evil.example/cb' })).toMatchObject({
      redirect: false,
      reason: 'redirect_uri',
    });
    expect(await ask({ ...good, code_challenge_method: 'plain' })).toMatchObject({
      redirect: true,
      error: 'invalid_request',
      state: 'xyz',
    });
    expect(await ask({ ...good, scope: 'everything' })).toMatchObject({ error: 'invalid_scope' });
    expect(await ask({ ...good, resource: 'https://other.example/mcp' })).toMatchObject({
      error: 'invalid_target',
    });
    expect(redirectWith('https://claude.ai/cb', { code: 'c', state: null }, ORIGIN)).toBe(
      `https://claude.ai/cb?code=c&iss=${encodeURIComponent(ORIGIN)}`,
    );
  });
});

describe('the tool mapping', () => {
  const calls: RestRequest[] = [];
  const fake = async (request: RestRequest) => {
    calls.push(request);
    if (request.method === 'GET' && request.path === '/meetings/m1') {
      return {
        status: 200,
        contentType: 'application/json',
        text: JSON.stringify({ shares: [{ id: 'u-anne', email: 'Anne@example.com' }] }),
      };
    }
    return { status: 200, contentType: 'application/json', text: '{"ok":1}' };
  };
  beforeEach(() => void (calls.length = 0));

  it('names the seven tools of the spec', () => {
    expect(TOOL_NAMES).toEqual([
      'list_meetings',
      'get_transcript',
      'get_minutes',
      'search',
      'save_minutes',
      'set_visibility',
      'share',
    ]);
    for (const name of TOOL_NAMES) expect(TOOLS[name].description.length).toBeGreaterThan(80);
    expect(TOOLS.list_meetings.description).toMatch(/private meetings never appear/);
  });

  it('wraps one REST call per tool', async () => {
    await runTool('list_meetings', { view: 'mine', q: 'budget', limit: 5 }, fake);
    await runTool('get_transcript', { meeting_id: 'm/1' }, fake);
    await runTool('get_minutes', { meeting_id: 'm1', format: 'markdown' }, fake);
    await runTool('search', { q: 'budget' }, fake);
    await runTool(
      'save_minutes',
      { meeting_id: 'm1', base_version_id: 'v1', body_md: '# x' },
      fake,
    );
    await runTool('set_visibility', { meeting_id: 'm1', visibility: 'company' }, fake);
    await runTool('share', { meeting_id: 'm1', action: 'add', email: 'anne@example.com' }, fake);
    expect(calls).toEqual([
      { method: 'GET', path: '/meetings', query: { view: 'mine', q: 'budget', limit: 5 } },
      { method: 'GET', path: '/meetings/m%2F1/transcript', query: { format: 'text' } },
      { method: 'GET', path: '/meetings/m1/recap', query: { format: 'markdown' } },
      { method: 'GET', path: '/search', query: { q: 'budget' } },
      {
        method: 'PUT',
        path: '/meetings/m1/recap',
        body: { base_version_id: 'v1', body_md: '# x' },
      },
      { method: 'PATCH', path: '/meetings/m1', body: { visibility: 'company' } },
      { method: 'POST', path: '/meetings/m1/shares', body: { email: 'anne@example.com' } },
    ]);
  });

  it("removes a reader named by address through the owner's view of the meeting", async () => {
    await runTool('share', { meeting_id: 'm1', action: 'remove', email: 'anne@example.com' }, fake);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /meetings/m1',
      'DELETE /meetings/m1/shares/u-anne',
    ]);
    expect(
      await runTool('share', { meeting_id: 'm1', action: 'add', email: 'a@x', user_id: 'u' }, fake),
    ).toMatchObject({ isError: true });
  });

  it("hands back the API's answer: JSON as structured content, an error as isError", async () => {
    const answer =
      (status: number, text: string, contentType = 'application/json') =>
      async () => ({
        status,
        contentType,
        text,
      });
    expect(await runTool('search', { q: 'x' }, answer(200, '{"results":[]}'))).toEqual({
      content: [{ type: 'text', text: '{"results":[]}' }],
      structuredContent: { results: [] },
    });
    expect(
      await runTool(
        'get_transcript',
        { meeting_id: 'm1' },
        answer(200, '00:00 Anne: Hej', 'text/plain'),
      ),
    ).toEqual({ content: [{ type: 'text', text: '00:00 Anne: Hej' }] });
    expect(
      await runTool(
        'get_minutes',
        { meeting_id: 'm1' },
        answer(404, '{"error":{"code":"not_found"}}'),
      ),
    ).toEqual({
      content: [{ type: 'text', text: '{"status":404,"error":{"code":"not_found"}}' }],
      isError: true,
    });
  });
});

describe('scope', () => {
  const mcp = (scope: ApiTokenScope) => ({ kind: 'mcp' as const, scope });

  it("takes an MCP connection's token only inside the MCP server, and refuses a read one a write", () => {
    expect(authorise(mcp('read_write'), { write: false, session: false })).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(authorise(mcp('read'), { write: false, session: false, mcp: true })).toEqual({
      ok: true,
    });
    expect(authorise(mcp('read'), { write: true, session: false, mcp: true })).toMatchObject({
      status: 403,
      code: 'insufficient_scope',
    });
    expect(authorise(mcp('read_write'), { write: true, session: false, mcp: true })).toEqual({
      ok: true,
    });
  });
});

describe('the MCP server on a database', () => {
  let ctx: { db: ReturnType<typeof testDb>['db']; raw: ReturnType<typeof testDb>['sqlite'] };
  let clientId: string;
  const REDIRECT = 'http://127.0.0.1:4000/callback';
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  /** The OAuth flow's two ends, as the consent page and a client run them. */
  async function connect(userId: string, scope: ApiTokenScope = 'read') {
    const code = newRecorderToken();
    await createOAuthCode(ctx.db, INSTALL, {
      codeHash: await hashRecorderToken(code),
      userId,
      clientId,
      clientName: 'Claude',
      redirectUri: REDIRECT,
      codeChallenge: await s256(VERIFIER),
      scope,
    });
    const response = await tokenRoute.POST(
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
        client_id: clientId,
        resource: `${ORIGIN}/mcp`,
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
  }
  const form = (fields: Record<string, string>) =>
    new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  let rpcId = 0;
  async function rpc(token: string | null, method: string, params: unknown = {}) {
    state.headers = new Headers(token ? { authorization: `Bearer ${token}` } : {});
    const response = await mcpRoute.POST(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      }),
    );
    return response;
  }
  /** A JSON-RPC answer, as JSON or as the one message of an event stream. */
  async function answer(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.headers.get('content-type')?.includes('text/event-stream'))
      return JSON.parse(text);
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data!.slice('data: '.length));
  }
  async function tool(token: string, name: string, args: Record<string, unknown>) {
    const response = await rpc(token, 'tools/call', { name, arguments: args });
    expect(response.status).toBe(200);
    const body = (await answer(response)) as {
      result: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown };
    };
    return body.result;
  }
  const audits = () =>
    ctx.raw
      .prepare(`select action, user_id, meeting_id, details from audit_events order by at, rowid`)
      .all() as { action: string; user_id: string; meeting_id: string | null; details: string }[];

  beforeEach(async () => {
    const fresh = testDb();
    ctx = { db: fresh.db, raw: fresh.sqlite };
    state.db = ctx.db;
    state.mcpEnabled = true;
    clientId = await signClient(KEY, { name: 'Claude', redirectUris: [REDIRECT] });
    ctx.raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name, is_admin) VALUES
      ('anne', '${INSTALL}', 'a', 'anne@example.com', 'Anne Holm', 0),
      ('jonas', '${INSTALL}', 'j', 'jonas@example.com', 'Jonas Skov', 1);
      INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES
      ('a1', '${INSTALL}', 'anne', 'Budget', 'budget', ${Date.UTC(2026, 9, 1)}, 'private'),
      ('jc', '${INSTALL}', 'jonas', 'Company', 'company', ${Date.UTC(2026, 9, 2)}, 'company'),
      ('jp', '${INSTALL}', 'jonas', 'Secret', 'secret', ${Date.UTC(2026, 9, 3)}, 'private');
      INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s, sha256,
        size_bytes, content_type, storage_path, status, is_primary, created_at, confirmed_at) VALUES
      ('r1', '${INSTALL}', 'a1', 'anne', 'upload', 60, '${'0'.repeat(64)}', 1, 'audio/webm', 'p', 'transcribed', 1, 1, 1);
      INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status)
        VALUES ('t1', '${INSTALL}', 'r1', 'assemblyai', 'u', 'da', '{}', 'done');
      INSERT INTO speakers (id, install_id, meeting_id, label, speaker_index)
        VALUES ('s1', '${INSTALL}', 'a1', 'Anne Holm', 0);
      INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text)
        VALUES ('g1', '${INSTALL}', 't1', 's1', 0, 1000, 'Budgettet holder.');`);
    const { beginDraft, writeVersion } = await import('../lib/recap/store');
    const draft = (await beginDraft(ctx.db, INSTALL, 'a1', null))!;
    await writeVersion(ctx.db, INSTALL, {
      recapId: draft.recapId,
      meetingId: 'a1',
      bodyMd: '# Budget\n\nAI-udkast.\n',
      authorId: null,
      draftToken: draft.token,
    });
  });

  it('answers 401 with the metadata address without a connection, and 404 when switched off', async () => {
    const bare = await rpc(null, 'tools/list');
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await rpc('mtxt_' + 'x'.repeat(43), 'tools/list');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
    state.mcpEnabled = false;
    expect((await rpc(null, 'tools/list')).status).toBe(404);
    expect((await tokenRoute.POST(form({ grant_type: 'refresh_token' }))).status).toBe(404);
  });

  it('registers a client without a row, and lists the seven tools to a connection', async () => {
    const registered = await registerRoute.POST(
      new Request(`${ORIGIN}/oauth/register`, {
        method: 'POST',
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
      }),
    );
    expect(registered.status).toBe(201);
    const body = (await registered.json()) as {
      client_id: string;
      token_endpoint_auth_method: string;
    };
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(await readClient(KEY, body.client_id)).toEqual({
      name: 'Claude',
      redirectUris: [REDIRECT],
    });

    const { access_token } = await connect('anne');
    const response = await rpc(access_token, 'tools/list');
    expect(response.status).toBe(200);
    const list = (await answer(response)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("reads what the user may read through the REST API's handlers, with via: mcp", async () => {
    const { access_token } = await connect('anne');
    const listed = await tool(access_token, 'list_meetings', {});
    const ids = (listed.structuredContent as { meetings: { id: string }[] }).meetings.map(
      (m) => m.id,
    );
    expect(ids).toEqual(['jc', 'a1']);
    const transcript = await tool(access_token, 'get_transcript', { meeting_id: 'a1' });
    expect(transcript.content[0]!.text).toContain('Anne Holm: Budgettet holder.');
    const minutes = await tool(access_token, 'get_minutes', { meeting_id: 'a1' });
    expect(minutes.structuredContent).toMatchObject({
      body_md: expect.stringContaining('AI-udkast'),
    });
    const found = await tool(access_token, 'search', { q: 'udkast' });
    expect(found.structuredContent).toMatchObject({ results: [{ meeting: { id: 'a1' } }] });
    // Another person's private meeting is as absent as one that does not exist.
    const secret = await tool(access_token, 'get_transcript', { meeting_id: 'jp' });
    expect(secret.isError).toBe(true);
    expect(secret.content[0]!.text).toContain('not_found');

    const rows = audits().filter((a) => a.action === 'exported');
    expect(rows.map((r) => [r.meeting_id, JSON.parse(r.details)])).toEqual([
      ['a1', { format: 'text', via: 'mcp', token: 'Claude' }],
      ['a1', { format: 'json', via: 'mcp', token: 'Claude' }],
    ]);
  });

  it('refuses a read connection a write, and audits a write with mcp_write', async () => {
    const read = await connect('anne', 'read');
    const minutes = (await tool(read.access_token, 'get_minutes', { meeting_id: 'a1' }))
      .structuredContent as { version: { id: string } };
    const refused = await tool(read.access_token, 'save_minutes', {
      meeting_id: 'a1',
      base_version_id: minutes.version.id,
      body_md: '# Budget\n\nRettet.\n',
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text)).toMatchObject({
      status: 403,
      error: { code: 'insufficient_scope' },
    });
    expect(audits().some((a) => a.action === 'mcp_write')).toBe(false);

    const write = await connect('anne', 'read_write');
    const saved = await tool(write.access_token, 'save_minutes', {
      meeting_id: 'a1',
      base_version_id: minutes.version.id,
      body_md: '# Budget\n\nRettet.\n',
    });
    expect(saved.isError).toBeUndefined();
    expect(saved.structuredContent).toMatchObject({
      version: { number: 2, author: { id: 'anne' } },
    });
    const visible = await tool(write.access_token, 'set_visibility', {
      meeting_id: 'a1',
      visibility: 'company',
    });
    expect(visible.structuredContent).toMatchObject({ visibility: 'company' });
    const writes = audits().filter((a) => ['mcp_write', 'visibility_changed'].includes(a.action));
    expect(writes.map((r) => [r.action, JSON.parse(r.details)])).toEqual([
      ['mcp_write', { tool: 'save_minutes', version: 2, via: 'mcp', token: 'Claude' }],
      ['visibility_changed', { before: 'private', after: 'company', via: 'mcp', token: 'Claude' }],
    ]);
    // A reader of a company meeting may not change it.
    const other = await tool(write.access_token, 'set_visibility', {
      meeting_id: 'jc',
      visibility: 'private',
    });
    expect(JSON.parse(other.content[0]!.text)).toMatchObject({ status: 403 });
  });

  it("refuses an MCP connection's token on the REST API itself", async () => {
    const { access_token } = await connect('anne', 'read_write');
    state.headers = new Headers({ authorization: `Bearer ${access_token}` });
    const response = await meetingsRoute.GET(new Request(`${ORIGIN}/api/v1/meetings`));
    expect(response.status).toBe(403);
  });

  it('exchanges a code once, and a second exchange revokes the connection', async () => {
    const code = newRecorderToken();
    await createOAuthCode(ctx.db, INSTALL, {
      codeHash: await hashRecorderToken(code),
      userId: 'anne',
      clientId,
      clientName: 'Claude',
      redirectUri: REDIRECT,
      codeChallenge: await s256(VERIFIER),
      scope: 'read',
    });
    const exchange = (fields: Record<string, string> = {}) =>
      tokenRoute.POST(
        form({
          grant_type: 'authorization_code',
          code,
          code_verifier: VERIFIER,
          redirect_uri: REDIRECT,
          client_id: clientId,
          ...fields,
        }),
      );
    expect((await exchange({ code_verifier: 'x'.repeat(43) })).status).toBe(400);
    expect((await exchange({ redirect_uri: 'http://127.0.0.1:4000/other' })).status).toBe(400);
    const first = await exchange();
    expect(first.status).toBe(200);
    const { access_token } = (await first.json()) as { access_token: string };
    expect((await rpc(access_token, 'tools/list')).status).toBe(200);
    const again = await exchange();
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await rpc(access_token, 'tools/list')).status).toBe(401);
    const created = audits().find((a) => a.action === 'api_token_created')!;
    expect(JSON.parse(created.details)).toEqual({ name: 'Claude', scope: 'read', kind: 'mcp' });
  });

  it('revokes the connection when two exchanges of one code run at once', async () => {
    const code = newRecorderToken();
    await createOAuthCode(ctx.db, INSTALL, {
      codeHash: await hashRecorderToken(code),
      userId: 'anne',
      clientId,
      clientName: 'Claude',
      redirectUri: REDIRECT,
      codeChallenge: await s256(VERIFIER),
      scope: 'read',
    });
    // Both exchanges read the code before either claims it, as two requests at once can.
    let reads = 0;
    let release = () => {};
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const grants = ctx.db.query.oauthGrants;
    let queue: Promise<unknown> = Promise.resolve();
    const raced = new Proxy(ctx.db, {
      get(target, key) {
        // D1 runs one batch at a time; the in-memory database needs that said.
        if (key === 'batch') {
          return (statements: Parameters<typeof target.batch>[0]) => {
            const run = queue.then(() => target.batch(statements));
            queue = run.catch(() => {});
            return run;
          };
        }
        if (key !== 'query') return Reflect.get(target, key);
        return new Proxy(target.query, {
          get(query, name) {
            if (name !== 'oauthGrants') return Reflect.get(query, name);
            return {
              findFirst: async (args: Parameters<typeof grants.findFirst>[0]) => {
                const row = await grants.findFirst(args);
                reads++;
                if (reads === 2) release();
                if (reads <= 2) await bothRead;
                return row;
              },
            };
          },
        });
      },
    });
    const exchange = async () =>
      redeemOAuthCode(raced, INSTALL, {
        codeHash: await hashRecorderToken(code),
        clientId,
        redirectUri: REDIRECT,
        challenge: await s256(VERIFIER),
        accessHash: await hashRecorderToken(newRecorderToken()),
        refreshHash: await hashRecorderToken(newRecorderToken()),
      });
    const results = await Promise.all([exchange(), exchange()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invalid_grant' }]);
    expect(await countMcpConnections(ctx.db, INSTALL, 'anne')).toBe(0);
  });

  it('refreshes with a new pair, after which the old refresh token is spent', async () => {
    const first = await connect('anne');
    const refresh = (token: string) =>
      tokenRoute.POST(
        form({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }),
      );
    const next = await refresh(first.refresh_token);
    expect(next.status).toBe(200);
    const pair = (await next.json()) as { access_token: string; refresh_token: string };
    expect(pair.access_token).not.toBe(first.access_token);
    expect((await rpc(first.access_token, 'tools/list')).status).toBe(401);
    expect((await rpc(pair.access_token, 'tools/list')).status).toBe(200);
    expect((await refresh(first.refresh_token)).status).toBe(400);
    // The access token lapses within the hour; the connection stays for its refresh.
    const later = new Date(Date.now() + MCP_ACCESS_LIFETIME_MS + 1000);
    expect(
      await findRecorderUser(ctx.db, INSTALL, await hashRecorderToken(pair.access_token), later),
    ).toBeNull();
    expect(
      await refreshMcpToken(ctx.db, INSTALL, {
        refreshHash: await hashRecorderToken(pair.refresh_token),
        clientId,
        accessHash: await hashRecorderToken(newRecorderToken()),
        nextRefreshHash: await hashRecorderToken(newRecorderToken()),
        now: later,
      }),
    ).toMatchObject({ ok: true });
  });

  it('revokes by either token, for its own client only', async () => {
    const { access_token, refresh_token } = await connect('anne');
    expect(
      await revokeMcpToken(ctx.db, INSTALL, {
        tokenHash: await hashRecorderToken(refresh_token),
        clientId: 'mcp1.other',
      }),
    ).toBe(false);
    expect(
      await revokeMcpToken(ctx.db, INSTALL, {
        tokenHash: await hashRecorderToken(refresh_token),
        clientId,
      }),
    ).toBe(true);
    expect((await rpc(access_token, 'tools/list')).status).toBe(401);
    expect(audits().filter((a) => a.action === 'api_token_revoked')).toHaveLength(1);
  });

  it('stops at 25 working connections per user', async () => {
    for (let i = 0; i < MAX_MCP_CONNECTIONS; i++) await connect('anne');
    expect(await countMcpConnections(ctx.db, INSTALL, 'anne')).toBe(MAX_MCP_CONNECTIONS);
    const code = newRecorderToken();
    await createOAuthCode(ctx.db, INSTALL, {
      codeHash: await hashRecorderToken(code),
      userId: 'anne',
      clientId,
      clientName: 'Claude',
      redirectUri: REDIRECT,
      codeChallenge: await s256(VERIFIER),
      scope: 'read',
    });
    expect(
      await redeemOAuthCode(ctx.db, INSTALL, {
        codeHash: await hashRecorderToken(code),
        clientId,
        redirectUri: REDIRECT,
        challenge: await s256(VERIFIER),
        accessHash: await hashRecorderToken(newRecorderToken()),
        refreshHash: await hashRecorderToken(newRecorderToken()),
      }),
    ).toEqual({ ok: false, reason: 'too_many' });
  });
});
