import { and, eq } from 'drizzle-orm';
import { schema } from '@mtxt/adapters';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { parseRange } from '@/lib/http-range';
import { getAdapters } from '@/lib/install';
import { accessTo } from '@/lib/meetings/queries';
import { isMediaType } from '@/lib/recordings/media-type';

/**
 * The audio of a recording, streamed from storage after the permission
 * check, with Range support so the player can seek. Audio never has a public
 * URL. Library-only: not part of the recorder contract.
 */
async function serve(request: Request, id: string, head: boolean) {
  return api(async (user) => {
    const { db, installId, storage } = await getAdapters();
    const row = await db
      .select({ recording: schema.recordings, meeting: schema.meetings })
      .from(schema.recordings)
      .innerJoin(
        schema.meetings,
        and(
          eq(schema.meetings.id, schema.recordings.meetingId),
          eq(schema.meetings.installId, installId),
        ),
      )
      .where(and(eq(schema.recordings.id, id), eq(schema.recordings.installId, installId)))
      .get();
    if (!row || !(await accessTo(db, installId, row.meeting, user)) || !row.recording.confirmedAt) {
      throw new HttpError(404, 'not_found', 'No audio for this recording.');
    }
    const key = row.recording.storagePath;
    const info = await storage.head(key);
    if (!info) throw new HttpError(404, 'not_found', 'The audio is not in storage.');

    const type = row.recording.contentType.split(';')[0]!.trim();
    const headers = new Headers({
      'accept-ranges': 'bytes',
      // Checked at create; checked again, so stored data can never be served as a page.
      'content-type': isMediaType(type) ? type : 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="recording.${extensionOf(key)}"`,
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
    // Present but empty is a malformed range (416), not an absent one.
    const header = request.headers.has('range') ? (request.headers.get('range') ?? '') : null;
    const range = parseRange(header, info.size);
    if (range === 'unsatisfiable') {
      headers.set('content-range', `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }
    const length = range ? range.length : info.size;
    headers.set('content-length', String(length));
    if (range) {
      headers.set(
        'content-range',
        `bytes ${range.offset}-${range.offset + length - 1}/${info.size}`,
      );
    }
    if (head) return new Response(null, { status: range ? 206 : 200, headers });
    const object = await storage.get(key, range ?? undefined);
    if (!object) throw new HttpError(404, 'not_found', 'The audio is not in storage.');
    return new Response(object.body, { status: range ? 206 : 200, headers });
  });
}

/** The stored file's extension, letters and digits only, for the download name. */
const extensionOf = (key: string) => /\.([a-z0-9]{1,8})$/i.exec(key)?.[1]?.toLowerCase() ?? 'audio';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return serve(request, (await params).id, false);
}

export async function HEAD(request: Request, { params }: Params) {
  return serve(request, (await params).id, true);
}
