import 'server-only';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as meetingRoute from '@/app/api/v1/meetings/[id]/route';
import * as recapRoute from '@/app/api/v1/meetings/[id]/recap/route';
import * as shareRoute from '@/app/api/v1/meetings/[id]/shares/[userId]/route';
import * as sharesRoute from '@/app/api/v1/meetings/[id]/shares/route';
import * as transcriptRoute from '@/app/api/v1/meetings/[id]/transcript/route';
import * as meetingsRoute from '@/app/api/v1/meetings/route';
import * as searchRoute from '@/app/api/v1/search/route';
import { MCP_MAX_BYTES } from '../chunk-guard';
import { runTool, TOOL_NAMES, TOOLS, type RestCall, type RestRequest } from './tools';

/*
  The MCP server (docs/spec.md "MCP"): Streamable HTTP, stateless, one
  server instance per request. Each tool runs the REST API's own route
  handler in this Worker, with a Request made for its path; the handler
  reads the caller from the /mcp request's own Authorization header, so
  the connection's user, scope, rate limit and audit rows are the REST
  API's, with `via: mcp` (lib/rest/handler.ts). There is no second
  permission path.
*/

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** The REST routes a tool may call, by method and path shape. */
const ROUTES: {
  method: RestRequest['method'];
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}[] = [
  { method: 'GET', pattern: /^\/meetings$/, keys: [], handler: meetingsRoute.GET as Handler },
  { method: 'GET', pattern: /^\/search$/, keys: [], handler: searchRoute.GET as Handler },
  {
    method: 'GET',
    pattern: /^\/meetings\/([^/]+)$/,
    keys: ['id'],
    handler: meetingRoute.GET as Handler,
  },
  {
    method: 'PATCH',
    pattern: /^\/meetings\/([^/]+)$/,
    keys: ['id'],
    handler: meetingRoute.PATCH as Handler,
  },
  {
    method: 'GET',
    pattern: /^\/meetings\/([^/]+)\/transcript$/,
    keys: ['id'],
    handler: transcriptRoute.GET as Handler,
  },
  {
    method: 'GET',
    pattern: /^\/meetings\/([^/]+)\/recap$/,
    keys: ['id'],
    handler: recapRoute.GET as Handler,
  },
  {
    method: 'PUT',
    pattern: /^\/meetings\/([^/]+)\/recap$/,
    keys: ['id'],
    handler: recapRoute.PUT as Handler,
  },
  {
    method: 'POST',
    pattern: /^\/meetings\/([^/]+)\/shares$/,
    keys: ['id'],
    handler: sharesRoute.POST as Handler,
  },
  {
    method: 'DELETE',
    pattern: /^\/meetings\/([^/]+)\/shares\/([^/]+)$/,
    keys: ['id', 'userId'],
    handler: shareRoute.DELETE as Handler,
  },
];

/** A RestCall that runs the REST API's route handlers in this request. */
export function routeCall(origin: string): RestCall {
  return async ({ method, path, query, body }) => {
    const route = ROUTES.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`No REST route for ${method} ${path}.`);
    const values = route.pattern.exec(path)!.slice(1).map(decodeURIComponent);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, values[i]!]));
    const url = new URL(`/api/v1${path}`, origin);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const request = new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const response = await route.handler(request, { params: Promise.resolve(params) });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: response.status === 204 ? '' : await response.text(),
    };
  };
}

/** One server instance with the seven tools, for one request. */
export function mcpServer(call: RestCall, productName: string): McpServer {
  const server = new McpServer(
    { name: 'mtxt', version: '0.3.0' },
    {
      instructions: `${productName}: the company's meeting library. Use list_meetings or search to find a meeting, then get_transcript or get_minutes to read it. Everything here acts as the signed-in user and sees only what they may see.`,
    },
  );
  for (const name of TOOL_NAMES) {
    const tool = TOOLS[name];
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args: Record<string, unknown>) => runTool(name, args, call),
    );
  }
  return server;
}

/** The Streamable HTTP handler: stateless, request bodies bounded like a recap save. */
export function mcpHandler(origin: string, productName: string) {
  return createMcpHandler(() => mcpServer(routeCall(origin), productName), {
    legacy: 'stateless',
    maxRequestBodySize: MCP_MAX_BYTES,
    onerror: (error) => console.error('MCP request failed:', error.name),
  });
}
