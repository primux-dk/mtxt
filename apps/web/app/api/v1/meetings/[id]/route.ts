import { audit, VISIBILITIES, type Visibility } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { cleanTitle, renameMeetingRows, setKeepRow } from '@/lib/meetings/changes';
import { applyVisibility } from '@/lib/meetings/sharing';
import { readJson } from '@/lib/recap/access';
import { rest, restJson } from '@/lib/rest/handler';
import { meetingDetail, restMeeting } from '@/lib/rest/meetings';
import { noParams } from '@/lib/rest/rules';
import { MEETING_PATCH_MAX_BYTES } from '@/lib/chunk-guard';

/*
  GET /api/v1/meetings/{id}: one meeting the token's user may read, with
  its recordings, transcript and recap state, and its readers for the
  owner. Served, it is an `opened` audit row with `via: api`.

  PATCH /api/v1/meetings/{id}: the owner sets the title, the visibility or
  the keep flag, with a `read_write` token. Each field sets a value, so a
  retry changes nothing twice. A visibility change is its audit row with
  `via: api`, and sends `meeting.shared` when access widens, as in the
  library.
*/
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return rest(request, {}, async ({ db, installId, user, via, served }) => {
    const extra = noParams(new URL(request.url).searchParams);
    if (extra) throw new HttpError(400, 'invalid_request', extra.error);
    const { id } = await params;
    const { meeting, access } = await restMeeting(db, installId, user, id, 'read');
    const detail = await meetingDetail(db, installId, user, meeting, access);
    served(() =>
      audit(db, installId, {
        userId: user.id,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        action: 'opened',
        details: via ?? undefined,
      }),
    );
    return restJson(detail);
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return rest(request, { write: true }, async (ctx) => {
    const { db, installId, user, via } = ctx;
    const { id } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'owner');
    const body = await readJson(
      request,
      MEETING_PATCH_MAX_BYTES,
      'A meeting change is at most 8 KiB.',
    );
    const keys = Object.keys(body);
    const unknown = keys.find((k) => !['title', 'visibility', 'keep'].includes(k));
    if (unknown) throw new HttpError(400, 'invalid_request', `Unknown field "${unknown}".`);
    if (!keys.length)
      throw new HttpError(400, 'invalid_request', 'Send title, visibility or keep.');
    const title = 'title' in body ? cleanTitle(body.title) : undefined;
    if (title === null)
      throw new HttpError(400, 'invalid_request', 'title is 1 to 500 characters.');
    if ('visibility' in body && !VISIBILITIES.includes(body.visibility as Visibility)) {
      throw new HttpError(
        400,
        'invalid_request',
        `visibility is one of ${VISIBILITIES.join(', ')}.`,
      );
    }
    if ('keep' in body && typeof body.keep !== 'boolean')
      throw new HttpError(400, 'invalid_request', 'keep is true or false.');

    if (title !== undefined && title !== meeting.title)
      await renameMeetingRows(db, installId, meeting.id, title);
    if (typeof body.keep === 'boolean' && body.keep !== meeting.keep)
      await setKeepRow(db, installId, meeting.id, body.keep);
    if (body.visibility !== undefined) {
      await applyVisibility(
        ctx,
        { ...meeting, title: title ?? meeting.title },
        body.visibility as Visibility,
        via,
      ).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 409) {
          throw new HttpError(
            409,
            'conflict',
            'The visibility changed meanwhile. Read the meeting and try again.',
          );
        }
        throw error;
      });
    }
    const fresh = await restMeeting(db, installId, user, id, 'owner');
    return restJson(await meetingDetail(db, installId, user, fresh.meeting, fresh.access));
  });
}
