// Exists only in an MTXT_E2E_BUILD=1 build. See lib/stt/fake-providers.ts.
import { transcriptRoute } from '@/lib/stt/fake-providers';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return transcriptRoute(request, (await params).id);
}
