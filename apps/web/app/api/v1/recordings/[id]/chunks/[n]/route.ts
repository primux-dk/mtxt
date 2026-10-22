import { api, json, recordingContext } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { uploadChunk } from '@/lib/recordings/service';

/**
 * One chunk, raw bytes. The service checks the caller, the recording and the
 * declared size before any byte is read, then hands the body stream to the
 * upload session, which reads at most one chunk of it.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const { id, n } = await params;
  return api(async (user) => {
    if (!/^\d{1,4}$/.test(n)) {
      throw new HttpError(400, 'invalid_request', 'The chunk number is a whole number from 1.');
    }
    return json(await uploadChunk(await recordingContext(), user, id, Number(n), request));
  });
}
