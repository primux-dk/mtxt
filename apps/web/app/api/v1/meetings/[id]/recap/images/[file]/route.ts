import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { recapMeeting } from '@/lib/recap/access';
import { IMAGE_FILE, imageKey, imageType, type ImageExt } from '@/lib/recap/images';

/** A recap image, to anyone who may read the meeting. Never a public URL. */
type Params = { params: Promise<{ id: string; file: string }> };

export async function GET(_request: Request, { params }: Params) {
  return api(async (user) => {
    const { id, file } = await params;
    const match = IMAGE_FILE.exec(file);
    if (!match) throw new HttpError(404, 'not_found', 'No such image.');
    const { storage, installId, meeting } = await recapMeeting(user, id, 'read');
    const object = await storage.get(imageKey(installId, meeting.id, file));
    if (!object) throw new HttpError(404, 'not_found', 'No such image.');
    return new Response(object.body, {
      headers: {
        'content-type': imageType(match[1] as ImageExt),
        'content-length': String(object.size),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=3600',
      },
    });
  });
}
