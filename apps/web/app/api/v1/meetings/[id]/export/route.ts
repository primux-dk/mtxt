import { audit } from '@mtxt/adapters';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { recapMeeting } from '@/lib/recap/access';
import { EXPORT_FORMATS, type ExportFormat } from '@/lib/recap/export';
import { recapFile } from '@/lib/recap/export-file';

/*
  The recap as a download: `?format=md` (the stored body) or `?format=docx`.
  Anyone who may read the meeting may export what they read. Each export is
  one `exported` audit row with the format. Library-only, not part of the
  recorder contract.
*/
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return api(async (user) => {
    const { id } = await params;
    const format = new URL(request.url).searchParams.get('format') ?? '';
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new HttpError(400, 'invalid_request', 'Ask for format=md or format=docx.');
    }
    const ctx = await recapMeeting(user, id, 'read');
    const response = await recapFile(ctx, ctx.meeting, format as ExportFormat);
    if (!response) throw new HttpError(404, 'not_found', 'This meeting has no recap yet.');
    await audit(ctx.db, ctx.installId, {
      userId: user.id,
      meetingId: ctx.meeting.id,
      meetingTitle: ctx.meeting.title,
      action: 'exported',
      details: { format: format as ExportFormat },
    });
    return response;
  });
}
