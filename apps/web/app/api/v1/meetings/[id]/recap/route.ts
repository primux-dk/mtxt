import { api, json } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { readJson, recapMeeting } from '@/lib/recap/access';
import { loadRecap, MAX_BODY_BYTES, writeVersion } from '@/lib/recap/store';
import { versionView } from '@/lib/recap/view';

/*
  The recap editor's save (behaviour.md rules 1 and 4). Library-only, not
  part of the recorder contract. The body names the version it was made on;
  a save whose base is no longer the current version is refused with 409 and
  the version that is current, so the editor can say who changed it and
  when. Only the owner saves.
*/
type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  return api(async (user) => {
    const { id } = await params;
    const { db, installId, meeting } = await recapMeeting(user, id, 'owner');
    const body = await readJson(request, MAX_BODY_BYTES + 4096);
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
    });
    if (result.ok) return json({ version: versionView(result.version) });
    if (result.reason === 'conflict') {
      return json(
        {
          error: { code: 'conflict', message: 'The recap was changed elsewhere.' },
          current: result.current ? versionView(result.current) : null,
        },
        409,
      );
    }
    throw new HttpError(404, 'not_found', 'This meeting has no recap.');
  });
}
