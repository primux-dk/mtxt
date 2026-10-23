import { audit } from '@mtxt/adapters';
import { HttpError } from '@/lib/http-error';
import { readJson } from '@/lib/recap/access';
import { RECAP_SAVE_MAX_BYTES } from '@/lib/chunk-guard';
import { recapFile } from '@/lib/recap/export-file';
import { loadRecap, RecapTooLongError, writeVersion } from '@/lib/recap/store';
import { rest, restJson } from '@/lib/rest/handler';
import { recapJson, recapVersionView, restMeeting } from '@/lib/rest/meetings';
import { parseFormat } from '@/lib/rest/rules';
import { SAVED_DELAY_S } from '@/lib/webhooks/rules';
import { queueMeetingEventQuietly } from '@/lib/webhooks/store';

/*
  GET /api/v1/meetings/{id}/recap (docs/spec.md "API"): the recap's current
  version as JSON (body, version, decisions), as markdown or as Word, for
  anyone who may read the meeting, with a personal API token. Served, it is
  an `exported` audit row with the format and `via: api`.

  PUT: the recap editor's save (behaviour.md rules 1 and 4), and the API's
  `save_minutes` with a `read_write` token. The body names the version it
  was made on; a save whose base is no longer the current version is
  refused with 409 and the version that is current, so the editor can say
  who changed it and when. Only the owner saves.
*/
type Params = { params: Promise<{ id: string }> };

const FORMATS = ['json', 'markdown', 'docx'] as const;

export async function GET(request: Request, { params }: Params) {
  return rest(request, {}, async ({ db, installId, storage, user, via, served }) => {
    const format = parseFormat(new URL(request.url).searchParams, FORMATS, 'json');
    if (typeof format === 'object') throw new HttpError(400, 'invalid_request', format.error);
    const { id } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'read');
    const response =
      format === 'json'
        ? await recapJson(db, installId, meeting.id).then((body) => body && restJson(body))
        : await recapFile(
            { db, installId, storage },
            meeting,
            format === 'markdown' ? 'md' : 'docx',
          );
    if (!response) throw new HttpError(404, 'not_found', 'This meeting has no recap yet.');
    served(() =>
      audit(db, installId, {
        userId: user.id,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
        action: 'exported',
        details: {
          format: format === 'markdown' ? 'md' : format,
          via: 'api',
          token: via!.token,
        },
      }),
    );
    // A file may be revalidated with its ETag like the JSON.
    response.headers.set('cache-control', 'private, no-cache');
    return response;
  });
}

export async function PUT(request: Request, { params }: Params) {
  return rest(request, { write: true, session: true }, async ({ db, installId, queue, user }) => {
    const { id } = await params;
    const { meeting } = await restMeeting(db, installId, user, id, 'owner').catch(
      (error: unknown) => {
        if (error instanceof HttpError && error.status === 403)
          throw new HttpError(403, 'forbidden', 'Only the owner edits the recap.');
        throw error;
      },
    );
    const body = await readJson(request, RECAP_SAVE_MAX_BYTES);
    const base = body.base_version_id;
    const markdown = body.body_md;
    if ((base !== null && typeof base !== 'string') || typeof markdown !== 'string') {
      throw new HttpError(400, 'invalid_request', 'Send base_version_id and body_md.');
    }
    const recap = await loadRecap(db, installId, meeting.id);
    if (!recap) throw new HttpError(404, 'not_found', 'This meeting has no recap yet.');
    const result = await writeVersion(db, installId, {
      recapId: recap.id,
      meetingId: meeting.id,
      bodyMd: markdown,
      authorId: user.id,
      base: { versionId: base },
    }).catch((error: unknown) => {
      // A size error is the client's: 413 with its reason, so the editor explains and waits.
      if (error instanceof RecapTooLongError) {
        throw new HttpError(413, 'too_large', error.message, { reason: 'recap_too_long' });
      }
      throw error;
    });
    if (result.ok) {
      // `recap.saved` a minute from now; the saves meanwhile join it (lib/webhooks/store.ts).
      await queueMeetingEventQuietly(
        { db, installId, queue },
        {
          event: 'recap.saved',
          meetingId: meeting.id,
          dedupeKey: `saved:${result.version.id}`,
          delayS: SAVED_DELAY_S,
        },
      );
      // The stored text: the editor takes it when it differs from what it sent.
      return Response.json(
        { version: recapVersionView(result.version), body_md: result.bodyMd },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (result.reason === 'conflict') {
      throw new HttpError(409, 'conflict', 'The recap was changed elsewhere.', {
        current: result.current ? recapVersionView(result.current) : null,
      });
    }
    throw new HttpError(404, 'not_found', 'This meeting has no recap.');
  });
}
