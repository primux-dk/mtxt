import { and, eq } from 'drizzle-orm';
import { audit, readSettings, schema } from '@mtxt/adapters';
import { getAdapters, getEnv } from '@/lib/install';
import { attachment, exportFileName } from '@/lib/recap/export';
import { recapFile } from '@/lib/recap/export-file';
import { readGrant } from '@/lib/webhooks/grant';
import { mayBeSent } from '@/lib/webhooks/rules';
import { transcriptExport } from '@/lib/webhooks/transcript';

/*
  A webhook's signed link (docs/spec.md "Webhooks", Links). Outside the
  session gate: the token is the grant, for one meeting and one format, one
  hour (lib/webhooks/grant.ts). The permission state is checked again now:
  the meeting must still be one that may be sent, and the endpoint must
  still exist and be enabled. Anything else is 404, the same as a meeting
  that does not exist; a valid but expired token is 410. Each fetch is an
  `exported` audit row naming the endpoint, with the owner as the user
  (there is no service identity).
*/
type Params = { params: Promise<{ token: string }> };

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const notFound = () =>
  json({ error: { code: 'not_found', message: 'No such export, or no longer available.' } }, 404);

export async function GET(_request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const env = await getEnv();
    if (!env.SETTINGS_KEY) return notFound();
    const check = await readGrant(env.SETTINGS_KEY, decodeURIComponent(token));
    if (!check.ok) {
      return check.reason === 'expired'
        ? json({ error: { code: 'gone', message: 'This link has expired.' } }, 410)
        : notFound();
    }
    const { grant } = check;
    const { db, installId, storage } = await getAdapters();
    const [meeting, endpoint, settings] = await Promise.all([
      db.query.meetings.findFirst({
        where: and(
          eq(schema.meetings.id, grant.meetingId),
          eq(schema.meetings.installId, installId),
        ),
      }),
      db.query.webhookEndpoints.findFirst({
        where: and(
          eq(schema.webhookEndpoints.id, grant.endpointId),
          eq(schema.webhookEndpoints.installId, installId),
        ),
      }),
      readSettings(db, installId),
    ]);
    if (!meeting || !endpoint?.enabled || !mayBeSent(meeting, settings.webhookAutoSend)) {
      return notFound();
    }

    let response: Response | null;
    if (grant.format === 'transcript') {
      const body = await transcriptExport(db, installId, meeting.id);
      response = body
        ? new Response(JSON.stringify(body), {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-disposition': attachment(
                exportFileName(meeting.title, meeting.startedAt, 'json'),
              ),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, no-store',
            },
          })
        : null;
    } else {
      response = await recapFile({ db, installId, storage }, meeting, grant.format);
    }
    if (!response) return notFound();
    await audit(db, installId, {
      userId: meeting.ownerId,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      action: 'exported',
      details: { format: grant.format, via: 'webhook', endpoint: endpoint.label },
    });
    return response;
  } catch (error) {
    console.error('Export link failed', (error as Error).name);
    return json(
      { error: { code: 'internal', message: 'Something went wrong on the server.' } },
      500,
    );
  }
}
