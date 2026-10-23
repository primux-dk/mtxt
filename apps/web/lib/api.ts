import 'server-only';
import { getApiUser, type SessionUser } from './auth/session';
import { HttpError } from './http-error';
import { getAdapters, getInstallSettings } from './install';
import type { RecordingContext } from './recordings/service';

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** The error shape of the contract: `{ error: { code, message } }`, plus `missing` for 409s. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    // Every 409 is the contract's Conflict: the reason, and for busy when to retry.
    const conflict =
      error.status === 409
        ? { reason: error.code, ...(error.code === 'busy' ? { retry_after: 1 } : {}) }
        : {};
    return json(
      { error: { code: error.code, message: error.message }, ...conflict, ...error.extra },
      error.status,
      error.headers,
    );
  }
  console.error(error);
  return json({ error: { code: 'internal', message: 'Something went wrong on the server.' } }, 500);
}

export async function recordingContext(): Promise<RecordingContext> {
  const [{ db, installId, storage, queue, uploads }, settings] = await Promise.all([
    getAdapters(),
    getInstallSettings(),
  ]);
  return { db, installId, storage, queue, uploads, settings };
}

/**
 * Runs an API handler with the caller (a recorder's bearer token or the
 * session cookie), turning errors into contract responses.
 */
export async function api(handler: (user: SessionUser) => Promise<Response>): Promise<Response> {
  try {
    const user = await getApiUser();
    // In the contract's error shape; the middleware sends most of these away first.
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in with the company login.');
    return await handler(user);
  } catch (error) {
    return errorResponse(error);
  }
}
