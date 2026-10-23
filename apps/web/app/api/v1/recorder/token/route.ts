import { errorResponse } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { pollForToken } from '@/lib/recorders/token-poll';

/** The recorder's token poll. Outside the session gate; it stands on the code verifier. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => {
      throw new HttpError(400, 'invalid_request', 'The body is not JSON.');
    });
    const [{ db, installId }, settings] = await Promise.all([getAdapters(), getInstallSettings()]);
    return await pollForToken({ db, installId, settings }, body);
  } catch (error) {
    return errorResponse(error);
  }
}
