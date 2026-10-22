import { api, json, recordingContext } from '@/lib/api';
import { getRecording } from '@/lib/recordings/service';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return api(async (user) => json(await getRecording(await recordingContext(), user, id)));
}
