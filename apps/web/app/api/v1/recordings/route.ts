import { api, json, recordingContext } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { createRecording } from '@/lib/recordings/service';

export async function POST(request: Request) {
  return api(async (user) => {
    const body = await request.json().catch(() => {
      throw new HttpError(400, 'invalid_request', 'The body is not JSON.');
    });
    return json(await createRecording(await recordingContext(), user, body), 201);
  });
}
