import { audit } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { attachment, exportFileName } from '@/lib/recap/export';
import { rest, restJson } from '@/lib/rest/handler';
import { restMeeting } from '@/lib/rest/meetings';
import { parseFormat } from '@/lib/rest/rules';
import { transcriptExport, transcriptText } from '@/lib/webhooks/transcript';

/*
  GET /api/v1/meetings/{id}/transcript (docs/spec.md "API"): the meeting's
  transcript as JSON (language, speakers, segments), the shape a webhook's
  transcript link gives, or `?format=text`, one line per segment. Served,
  it is an `exported` audit row with the format and `via: api`.
*/
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return rest(request, {}, async ({ db, installId, user, via, served }) => {
    const format = parseFormat(new URL(request.url).searchParams, ['json', 'text'], 'json');
    if (typeof format === 'object') throw new HttpError(400, 'invalid_request', format.error);
    const { id } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'read');
    const transcript = await transcriptExport(db, installId, meeting.id);
    if (!transcript) throw new HttpError(404, 'not_found', 'This meeting has no transcript yet.');
    served(() =>
      audit(db, installId, {
        userId: user.id,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        action: 'exported',
        details: {
          format: format === 'json' ? 'transcript' : 'text',
          ...via!,
        },
      }),
    );
    if (format === 'json') return restJson(transcript);
    return new Response(transcriptText(transcript), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': attachment(exportFileName(meeting.title, meeting.startedAt, 'txt')),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-cache',
      },
    });
  });
}
