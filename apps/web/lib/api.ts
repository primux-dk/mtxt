import 'server-only';
import { getCurrentUser, type CurrentUser } from './auth';
import { HttpError } from './http-error';
import { getAdapters, getInstallSettings } from './install';
import type { RecordingContext } from './recordings/service';

export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** The error shape of the contract: `{ error: { code, message } }`, plus `missing` for 409s. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message }, ...error.extra },
      error.status,
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

/** Runs an API handler with the signed-in user, turning errors into contract responses. */
export async function api(handler: (user: CurrentUser) => Promise<Response>): Promise<Response> {
  try {
    return await handler(await getCurrentUser());
  } catch (error) {
    return errorResponse(error);
  }
}
