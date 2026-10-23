import * as z from 'zod/v4';
import { LIST_STATUSES, LIST_VIEWS, MAX_LIMIT } from '../rest/rules';

/*
  The MCP tools (docs/spec.md "MCP"). Each wraps one REST API call one to
  one ("MCP mapping" in "API"): the tool builds the call, the REST API's
  own route handler runs it with the connection's user and scope
  (lib/mcp/server.ts), and the tool hands back the API's answer as it is.
  No permission rule lives here: what a tool may see or change is what the
  REST API lets the user see or change. `share` with an address to remove
  first reads the meeting, as the owner, to find the reader's id.
*/

export type RestMethod = 'GET' | 'PUT' | 'PATCH' | 'POST' | 'DELETE';

export interface RestRequest {
  method: RestMethod;
  /** Under /api/v1, starting with a slash. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface RestAnswer {
  status: number;
  contentType: string;
  text: string;
}

/** Runs one REST API call as the connection's user (lib/mcp/server.ts). */
export type RestCall = (request: RestRequest) => Promise<RestAnswer>;

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The API's answer as the tool's result: JSON as structured content too; an error is `isError`. */
export function toolResult(answer: RestAnswer): ToolResult {
  const isError = answer.status >= 400;
  if (answer.status === 204)
    return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
  if (answer.contentType.includes('json')) {
    try {
      const parsed = JSON.parse(answer.text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const body = isError ? { status: answer.status, ...parsed } : parsed;
        return {
          content: [{ type: 'text', text: JSON.stringify(body) }],
          ...(isError ? { isError } : { structuredContent: body as Record<string, unknown> }),
        };
      }
    } catch {
      // Not JSON after all: handed back as text below.
    }
  }
  return { content: [{ type: 'text', text: answer.text }], ...(isError ? { isError } : {}) };
}

const meetingId = z
  .string()
  .min(1)
  .max(64)
  .describe('The meeting id, as list_meetings and search give it.');

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const PRIVATE_NOTE =
  "Only meetings the signed-in user may read are visible: their own, company-wide ones, and shared ones that name them. Other people's private meetings never appear, and a meeting the user may not read answers as if it did not exist.";

export const TOOLS = {
  list_meetings: {
    title: 'List meetings',
    description: `Lists the meetings the user may read, newest first, a page at a time. Each meeting has its id, title, start time, owner, visibility (private, shared or company), the user's access (owner or reader), its state, duration, speakers and whether it has a transcript and a recap; no transcript text. ${PRIVATE_NOTE} \`view\` picks which meetings: all (default: everything the user may read), mine (the user's own, not archived), shared (shared with the user by name), company (company-wide), archived (the user's own archived ones). \`q\` filters by words in the title, transcript or recap. Pass \`next_cursor\` from the answer back as \`cursor\` for the next page; it is null on the last page.`,
    inputSchema: z.object({
      view: z.enum(LIST_VIEWS).optional().describe('Which meetings. Default all.'),
      q: z
        .string()
        .max(200)
        .optional()
        .describe('Words to find in titles, transcripts and recaps.'),
      status: z
        .enum(LIST_STATUSES)
        .optional()
        .describe('ready (transcribed), transcribing, or failed.'),
      since: z
        .string()
        .max(40)
        .optional()
        .describe(
          'Only meetings that started at or after this ISO 8601 time, e.g. 2026-10-01T00:00:00Z.',
        ),
      cursor: z.string().max(512).optional().describe('next_cursor from the previous page.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe('Meetings per page, 1 to 100. Default 50.'),
    }),
    annotations: READ,
    call: (args: {
      view?: string;
      q?: string;
      status?: string;
      since?: string;
      cursor?: string;
      limit?: number;
    }): RestRequest[] => [{ method: 'GET', path: '/meetings', query: args }],
  },
  get_transcript: {
    title: 'Get a transcript',
    description: `Returns a meeting's transcript. format text (default) is one line per segment: the time from the start, the speaker's name and what was said, the cheapest way to read a meeting. format json has the language, the speakers and every segment with start_ms, end_ms, speaker_id and text. ${PRIVATE_NOTE} A meeting still being transcribed has no transcript yet. Reading a transcript is written to the company's audit log.`,
    inputSchema: z.object({
      meeting_id: meetingId,
      format: z.enum(['text', 'json']).optional().describe('text (default) or json.'),
    }),
    annotations: READ,
    call: (args: { meeting_id: string; format?: 'text' | 'json' }): RestRequest[] => [
      {
        method: 'GET',
        path: `/meetings/${encodeURIComponent(args.meeting_id)}/transcript`,
        query: { format: args.format ?? 'text' },
      },
    ],
  },
  get_minutes: {
    title: 'Get the minutes',
    description: `Returns a meeting's minutes (the recap): format json (default) gives body_md, the markdown, with its version (id, number, author, time) and the decisions; format markdown gives the markdown alone. To change the minutes, pass version.id as base_version_id to save_minutes. ${PRIVATE_NOTE} Reading the minutes is written to the company's audit log.`,
    inputSchema: z.object({
      meeting_id: meetingId,
      format: z.enum(['json', 'markdown']).optional().describe('json (default) or markdown.'),
    }),
    annotations: READ,
    call: (args: { meeting_id: string; format?: 'json' | 'markdown' }): RestRequest[] => [
      {
        method: 'GET',
        path: `/meetings/${encodeURIComponent(args.meeting_id)}/recap`,
        query: { format: args.format ?? 'json' },
      },
    ],
  },
  search: {
    title: 'Search meetings',
    description: `Searches the titles, transcripts and minutes of the meetings the user may read, best match first. Each result has the meeting, what matched (title, recap or transcript), a snippet as parts with the matched words marked hit, and for a transcript hit start_s, the second it was said. ${PRIVATE_NOTE} \`q\` is the words to find, 1 to 200 characters. Pass \`next_cursor\` back as \`cursor\` for more.`,
    inputSchema: z.object({
      q: z.string().min(1).max(200).describe('The words to find.'),
      cursor: z.string().max(512).optional().describe('next_cursor from the previous page.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe('Results per page, 1 to 100. Default 50.'),
    }),
    annotations: READ,
    call: (args: { q: string; cursor?: string; limit?: number }): RestRequest[] => [
      { method: 'GET', path: '/search', query: args },
    ],
  },
  save_minutes: {
    title: 'Save the minutes',
    description: `Saves new minutes (recap) for one of the user's own meetings, as a new version on top of base_version_id, the version.id get_minutes gave. body_md is the whole markdown, not a change. If someone saved meanwhile, the save is refused with a conflict and the current version: read the minutes again and redo the change on them. Only the meeting's owner saves, and only with a connection that may read and write. Every version is kept and can be restored in the library, and the save is written to the audit log.`,
    inputSchema: z.object({
      meeting_id: meetingId,
      base_version_id: z
        .string()
        .max(64)
        .nullable()
        .describe('version.id from get_minutes; null only when the minutes have no version yet.'),
      body_md: z.string().max(400_000).describe('The whole minutes as markdown.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    call: (args: {
      meeting_id: string;
      base_version_id: string | null;
      body_md: string;
    }): RestRequest[] => [
      {
        method: 'PUT',
        path: `/meetings/${encodeURIComponent(args.meeting_id)}/recap`,
        body: { base_version_id: args.base_version_id, body_md: args.body_md },
      },
    ],
  },
  set_visibility: {
    title: 'Set who can see a meeting',
    description: `Sets the visibility of one of the user's own meetings: private (the owner alone), shared (the owner and the colleagues named with share), or company (everyone in the company). Making a meeting private removes its named readers. Only the owner changes it, and only with a connection that may read and write. Returns the meeting. The change is written to the audit log.`,
    inputSchema: z.object({
      meeting_id: meetingId,
      visibility: z.enum(['private', 'shared', 'company']),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    call: (args: { meeting_id: string; visibility: string }): RestRequest[] => [
      {
        method: 'PATCH',
        path: `/meetings/${encodeURIComponent(args.meeting_id)}`,
        body: { visibility: args.visibility },
      },
    ],
  },
  share: {
    title: 'Share a meeting with a colleague',
    description: `Adds a colleague as a reader of one of the user's own meetings, or removes one. The meeting must have visibility shared (use set_visibility first). Name the colleague by email or by user_id, not both. Adding returns the readers; removing returns ok. A colleague who is not a user of this company's install is not found. Only the owner shares, and only with a connection that may read and write. The change is written to the audit log.`,
    inputSchema: z.object({
      meeting_id: meetingId,
      action: z.enum(['add', 'remove']),
      email: z.string().max(320).optional().describe("The colleague's work email."),
      user_id: z.string().max(64).optional().describe("The colleague's user id."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    call: (args: {
      meeting_id: string;
      action: 'add' | 'remove';
      email?: string;
      user_id?: string;
    }): RestRequest[] => {
      const path = `/meetings/${encodeURIComponent(args.meeting_id)}`;
      if (args.action === 'add') {
        return [
          {
            method: 'POST',
            path: `${path}/shares`,
            body: args.user_id !== undefined ? { user_id: args.user_id } : { email: args.email },
          },
        ];
      }
      return [
        { method: 'DELETE', path: `${path}/shares/${encodeURIComponent(args.user_id ?? '')}` },
      ];
    },
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

const fail = (message: string): ToolResult => ({
  content: [
    { type: 'text', text: JSON.stringify({ error: { code: 'invalid_request', message } }) },
  ],
  isError: true,
});

/** Runs a tool: its REST call, and `share`'s lookup of a reader by address first. */
export async function runTool(
  name: ToolName,
  args: Record<string, unknown>,
  call: RestCall,
): Promise<ToolResult> {
  if (name === 'share') {
    const a = args as {
      meeting_id: string;
      action: 'add' | 'remove';
      email?: string;
      user_id?: string;
    };
    if ((a.email === undefined) === (a.user_id === undefined))
      return fail('Name the colleague by exactly one of email or user_id.');
    if (a.action === 'remove' && a.email !== undefined) {
      // The removal names an id; the owner's view of the meeting lists its readers.
      const meeting = await call({
        method: 'GET',
        path: `/meetings/${encodeURIComponent(a.meeting_id)}`,
      });
      if (meeting.status !== 200) return toolResult(meeting);
      const shares = (
        JSON.parse(meeting.text) as { shares?: { id: string; email?: string }[] | null }
      ).shares;
      const reader = shares?.find((s) => s.email?.toLowerCase() === a.email!.trim().toLowerCase());
      if (!reader) {
        return toolResult({
          status: 404,
          contentType: 'application/json',
          text: JSON.stringify({
            error: { code: 'not_found', message: 'No reader of this meeting has that address.' },
          }),
        });
      }
      return toolResult(
        await call(TOOLS.share.call({ ...a, email: undefined, user_id: reader.id })[0]!),
      );
    }
  }
  const tool = TOOLS[name] as { call: (args: never) => RestRequest[] };
  const [request] = tool.call(args as never);
  return toolResult(await call(request!));
}
