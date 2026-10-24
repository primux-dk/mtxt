import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN, d1, DESKTOP, openUserMenu, PHONE, settle, shot, signIn } from './helpers';

/*
  Packet 17: the MCP server (docs/spec.md "MCP"). The official MCP client
  connects to /mcp the way Claude, ChatGPT or Cursor do: it finds the
  protected resource metadata through the 401, registers itself, sends the
  user to the install's consent page with PKCE, and exchanges the code.
  The page is a real signed-in browser page here. Then the client calls
  the tools, and the audit rows they wrote are read from the local D1.
*/
const IDA = { email: 'mcp.ida@example.com', name: 'Ida Mortensen', admin: false };
const CALLBACK = 'http://127.0.0.1:9/callback';
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** An OAuth client provider that keeps its state in memory and hands the redirect to a page. */
function provider(onRedirect: (url: URL) => Promise<void>): OAuthClientProvider & {
  saved: { tokens?: { access_token: string } };
} {
  const saved: Record<string, unknown> & { tokens?: { access_token: string } } = {};
  return {
    saved,
    get redirectUrl() {
      return CALLBACK;
    },
    get clientMetadata() {
      return {
        client_name: 'e2e MCP client',
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => saved.client as never,
    saveClientInformation: (info) => void (saved.client = info),
    tokens: () => saved.tokens as never,
    saveTokens: (tokens) => void (saved.tokens = tokens as never),
    redirectToAuthorization: (url) => onRedirect(url),
    saveCodeVerifier: (v) => void (saved.verifier = v),
    codeVerifier: () => saved.verifier as string,
  };
}

/**
 * Connects through the whole OAuth flow, approving with `scope` on the
 * consent page in `page`, and answers the connected client.
 */
async function connect(
  page: Page,
  baseURL: string,
  scope: 'Read only' | 'Read and write',
  screenshot?: string,
) {
  let consent: Promise<URLSearchParams> | null = null;
  const auth = provider(async (url) => {
    consent = (async () => {
      await page.goto(url.toString());
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        /^Connect e2e MCP client to .+\?$/,
      );
      await page.getByRole('radio', { name: new RegExp(`^${scope}`) }).check();
      if (screenshot) {
        await settle(page);
        await page.screenshot({ path: shot(screenshot) });
      }
      const back = page.waitForRequest((r) => r.url().startsWith(CALLBACK));
      await page.getByRole('button', { name: 'Approve' }).click();
      return new URL((await back).url()).searchParams;
    })();
  });
  const url = new URL('/mcp', baseURL);
  const first = new StreamableHTTPClientTransport(url, { authProvider: auth });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await expect(client.connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
  expect(consent).not.toBeNull();
  const params = await consent!;
  expect(params.get('iss')).toBe(new URL(baseURL).origin);
  await first.finishAuth(params);
  const connected = new Client({ name: 'e2e', version: '1.0.0' });
  await connected.connect(new StreamableHTTPClientTransport(url, { authProvider: auth }));
  return { client: connected, token: auth.saved.tokens!.access_token };
}

const text = (result: unknown) =>
  (result as { content: { type: string; text: string }[] }).content[0]!.text;

test.describe.configure({ mode: 'serial' });

test('the MCP server is off until an admin turns it on, and the settings say how to connect', async ({
  page,
  request,
}) => {
  expect((await request.post('/mcp', { data: {} })).status()).toBe(404);
  expect((await request.get('/.well-known/oauth-protected-resource/mcp')).status()).toBe(404);
  await page.setViewportSize(DESKTOP);
  await signIn(page, ADMIN);
  await page.goto('/settings/sharing');
  const setup = page.getByTestId('mcp-setup');
  await expect(setup).toContainText(`${new URL(page.url()).origin}/mcp`);
  await expect(setup).toContainText('claude mcp add --transport http mtxt');
  await page.locator('#mcpEnabled').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.locator('#mcp-heading').scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: shot('mcp-settings'), fullPage: false });

  const bare = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(bare.status()).toBe(401);
  expect(bare.headers()['www-authenticate']).toMatch(
    /resource_metadata=".+\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  const resource = await (await request.get('/.well-known/oauth-protected-resource/mcp')).json();
  expect(resource).toMatchObject({ scopes_supported: ['read', 'read_write'] });
  const server = await (await request.get('/.well-known/oauth-authorization-server')).json();
  expect(server).toMatchObject({ code_challenge_methods_supported: ['S256'] });
});

test('an MCP client connects through OAuth and reads and writes as its user', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP);
  await signIn(page, IDA);
  const ida = d1<{ id: string }>(`select id from users where email = ${q(IDA.email)}`)[0]!.id;
  const jonas = d1<{ id: string }>(
    `select id from users where email = 'jonas.skov@example.com'`,
  )[0]!.id;
  const at = Date.UTC(2026, 9, 21, 9);
  const body = '# Referat\n\nVi aftalte at bestille færgen til Fanø.\n';
  d1(
    [
      `INSERT INTO meetings (id, install_id, owner_id, title, title_folded, started_at, visibility) VALUES
        ('mcp-ida-1', 'dev', ${q(ida)}, 'MCP-møde om færgen', 'mcp-møde om færgen', ${at}, 'private'),
        ('mcp-jonas-1', 'dev', ${q(jonas)}, 'Jonas privat MCP', 'jonas privat mcp', ${at + 1}, 'private');`,
      `INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, is_primary, duration_s, sha256, size_bytes, content_type, storage_path, status, created_at, confirmed_at) VALUES ('mcp-ida-1-r', 'dev', 'mcp-ida-1', ${q(ida)}, 'upload', 1, 70, '${'0'.repeat(64)}', 1, 'audio/webm', 'recordings/dev/mcp-ida-1/r.webm', 'transcribed', ${at}, ${at});`,
      `INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status) VALUES ('mcp-ida-1-t', 'dev', 'mcp-ida-1-r', 'assemblyai', 'u', 'da', '{}', 'done');`,
      `INSERT INTO speakers (id, install_id, meeting_id, label, user_id, speaker_index) VALUES ('mcp-ida-1-s0', 'dev', 'mcp-ida-1', 'Ida Mortensen', ${q(ida)}, 0);`,
      `INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES ('mcp-ida-1-g0', 'dev', 'mcp-ida-1-t', 'mcp-ida-1-s0', 0, 3000, 'Vi bestiller færgen til Fanø i dag.');`,
      `INSERT INTO recaps (id, install_id, meeting_id, body_md, status) VALUES ('mcp-ida-1-c', 'dev', 'mcp-ida-1', ${q(body)}, 'ready');`,
      `INSERT INTO recap_versions (id, install_id, recap_id, number, author_id, body_md, created_at) VALUES ('mcp-ida-1-v1', 'dev', 'mcp-ida-1-c', 1, NULL, ${q(body)}, ${at});`,
      `UPDATE recaps SET current_version_id = 'mcp-ida-1-v1' WHERE id = 'mcp-ida-1-c';`,
      `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES ('dev', 'mcp-ida-1', 'm' || lower(hex('mcp-ida-1')), 'segment', 'mcp-ida-1-g0', 'Vi bestiller færgen til Fanø i dag.');`,
      `INSERT INTO meeting_search (install_id, meeting_id, meeting_key, kind, ref, text) VALUES ('dev', 'mcp-jonas-1', 'm' || lower(hex('mcp-jonas-1')), 'segment', 'mcp-jonas-1', 'Fanø er hemmeligt.');`,
    ].join('\n'),
  );

  // Read only first: the consent page, then the tools.
  await page.route(`${CALLBACK}**`, (route) => route.fulfill({ body: 'Connected.' }));
  const read = await connect(page, baseURL!, 'Read only', 'mcp-consent');
  const tools = await read.client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual(
    [
      'get_minutes',
      'get_transcript',
      'list_meetings',
      'save_minutes',
      'search',
      'set_visibility',
      'share',
    ].sort(),
  );
  const listed = JSON.parse(
    text(await read.client.callTool({ name: 'list_meetings', arguments: { view: 'mine' } })),
  ) as {
    meetings: { id: string }[];
  };
  expect(listed.meetings.map((m) => m.id)).toEqual(['mcp-ida-1']);
  expect(
    text(
      await read.client.callTool({
        name: 'get_transcript',
        arguments: { meeting_id: 'mcp-ida-1' },
      }),
    ),
  ).toContain('Ida Mortensen: Vi bestiller færgen til Fanø i dag.');
  const found = JSON.parse(
    text(await read.client.callTool({ name: 'search', arguments: { q: 'Fanø' } })),
  ) as {
    results: { meeting: { id: string } }[];
  };
  expect(found.results.map((r) => r.meeting.id)).toEqual(['mcp-ida-1']);
  const refused = await read.client.callTool({
    name: 'save_minutes',
    arguments: { meeting_id: 'mcp-ida-1', base_version_id: 'mcp-ida-1-v1', body_md: '# Nej\n' },
  });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain('insufficient_scope');

  // Read and write: the save goes through as Ida, on the version it read.
  const write = await connect(page, baseURL!, 'Read and write');
  const minutes = JSON.parse(
    text(
      await write.client.callTool({ name: 'get_minutes', arguments: { meeting_id: 'mcp-ida-1' } }),
    ),
  ) as { version: { id: string } };
  const saved = await write.client.callTool({
    name: 'save_minutes',
    arguments: {
      meeting_id: 'mcp-ida-1',
      base_version_id: minutes.version.id,
      body_md: '# Referat\n\nVi bestilte færgen til Fanø.\n',
    },
  });
  expect(saved.isError).toBeFalsy();
  expect(JSON.parse(text(saved))).toMatchObject({ version: { number: 2, author: { id: ida } } });

  const rows = d1<{ action: string; meeting_id: string | null; details: string }>(
    `select action, meeting_id, details from audit_events where user_id = ${q(ida)} order by at, rowid`,
  ).map((r) => [r.action, r.meeting_id, JSON.parse(r.details ?? 'null')]);
  expect(rows).toEqual([
    ['api_token_created', null, { name: 'e2e MCP client', scope: 'read', kind: 'mcp' }],
    ['exported', 'mcp-ida-1', { format: 'text', via: 'mcp', token: 'e2e MCP client' }],
    ['api_token_created', null, { name: 'e2e MCP client', scope: 'read_write', kind: 'mcp' }],
    ['exported', 'mcp-ida-1', { format: 'json', via: 'mcp', token: 'e2e MCP client' }],
    [
      'mcp_write',
      'mcp-ida-1',
      { tool: 'save_minutes', version: 2, via: 'mcp', token: 'e2e MCP client' },
    ],
  ]);

  // Both connections show under API tokens, marked MCP; revoking one stops it at once.
  await page.goto('/meetings');
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitem', { name: 'API tokens' }).click();
  const dialog = page.getByRole('dialog', { name: 'API tokens' });
  const list = dialog.getByTestId('api-tokens-list');
  await expect(list.getByText('MCP', { exact: true })).toHaveCount(2);
  await settle(page);
  await page.screenshot({ path: shot('mcp-api-tokens') });
  await list.getByRole('button', { name: 'Revoke e2e MCP client' }).first().click();
  await expect(list.getByText('MCP', { exact: true })).toHaveCount(1);
  const after = await fetch(new URL('/mcp', baseURL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${write.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  // The newest row is the read-and-write connection; it is the one revoked.
  expect(after.status).toBe(401);
  await read.client.close();
  await write.client.close();
});

test('the consent page at a phone width, and a request it refuses to send anywhere', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(PHONE);
  await signIn(page, IDA);
  const registered = await fetch(new URL('/oauth/register', baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    }),
  });
  const { client_id } = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope: 'read_write',
    state: 's',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Connect Claude to .+\?$/);
  await expect(page.getByTestId('oauth-returns-to')).toContainText('claude.ai');
  await expect(page.getByRole('radio', { name: /^Read and write/ })).toBeChecked();
  await settle(page);
  await page.screenshot({ path: shot('mcp-consent-phone'), fullPage: true });

  query.set('redirect_uri', 'https://evil.example/cb');
  await page.goto(`/oauth/authorize?${query}`);
  await expect(
    page.getByRole('alert', { name: 'This connection request does not work' }),
  ).toContainText('did not register');
  await expect(page).toHaveURL(/\/oauth\/authorize/);
});
