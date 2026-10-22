import { CHUNK_SIZE_BYTES } from '@mtxt/contract';
import { api, json, recordingContext } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { uploadChunk } from '@/lib/recordings/service';

/** One chunk, raw bytes. Held in memory once, at most 8 MB, then handed to the upload session. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const { id, n } = await params;
  return api(async (user) => {
    const declared = Number(request.headers.get('content-length'));
    if (declared > CHUNK_SIZE_BYTES) {
      throw new HttpError(413, 'too_large', `A chunk is at most ${CHUNK_SIZE_BYTES} bytes.`);
    }
    if (!/^\d+$/.test(n))
      throw new HttpError(400, 'invalid_request', 'The chunk number is a whole number from 1.');
    const body = await request.arrayBuffer();
    if (body.byteLength > CHUNK_SIZE_BYTES) {
      throw new HttpError(413, 'too_large', `A chunk is at most ${CHUNK_SIZE_BYTES} bytes.`);
    }
    return json(await uploadChunk(await recordingContext(), user, id, Number(n), body));
  });
}
