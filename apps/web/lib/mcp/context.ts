import { AsyncLocalStorage } from 'node:async_hooks';

/*
  Set while the MCP server runs a tool (app/mcp/route.ts). The REST
  handler (lib/rest/handler.ts) takes an MCP connection's token only
  inside it: an MCP token is for /mcp, which calls the REST API's own
  route handlers, and is refused on the REST API's paths themselves.
*/
export interface McpCall {
  /** The MCP client's name, for the audit rows' `token`. */
  client: string;
}

const store = new AsyncLocalStorage<McpCall>();

export const runInMcp = <T>(call: McpCall, run: () => Promise<T>): Promise<T> =>
  store.run(call, run);

/** The MCP call this code runs in, if any. */
export const mcpCall = (): McpCall | undefined => store.getStore();
