import { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { stripSignInParams } from '@/lib/auth/identity';

// A sign-in request reaches Auth.js with callbackUrl and the CSRF token only,
// never authorization parameters such as client_id (lib/auth/identity.ts).
async function allowlisted(request: NextRequest): Promise<NextRequest> {
  const stripped = await stripSignInParams(request);
  if (stripped === request) return request;
  const body = stripped.method === 'POST' ? await stripped.text() : undefined;
  return new NextRequest(stripped.url, {
    method: stripped.method,
    headers: stripped.headers,
    body,
  });
}

export const GET = async (request: NextRequest) => handlers.GET(await allowlisted(request));
export const POST = async (request: NextRequest) => handlers.POST(await allowlisted(request));
