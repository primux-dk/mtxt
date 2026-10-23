import { api, json } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { recapMeeting } from '@/lib/recap/access';
import { imageKey, imageSrc, imageType, MAX_IMAGE_BYTES, sniffImage } from '@/lib/recap/images';

/** An image for the recap, from its owner: PNG, JPEG, GIF or WebP, at most 8 MiB. */
type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return api(async (user) => {
    const { id } = await params;
    const { storage, installId, meeting } = await recapMeeting(user, id, 'owner');
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES)
      throw new HttpError(413, 'too_large', 'An image is at most 8 MiB.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'invalid_request', 'Send the image as the body.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'too_large', 'An image is at most 8 MiB.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    const ext = sniffImage(bytes);
    if (!ext)
      throw new HttpError(415, 'unsupported_media_type', 'Use a PNG, JPEG, GIF or WebP image.');
    const file = `${crypto.randomUUID()}.${ext}`;
    await storage.put(imageKey(installId, meeting.id, file), bytes, {
      contentType: imageType(ext),
    });
    return json({ src: imageSrc(meeting.id, file) }, 201);
  });
}
