import { api, json, recordingContext } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { completeRecording } from '@/lib/recordings/service';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(async (user) => {
    const text = await request.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new HttpError(400, 'invalid_request', 'The body is not JSON.');
    }
    return json(await completeRecording(await recordingContext(), user, id, body));
  });
}
