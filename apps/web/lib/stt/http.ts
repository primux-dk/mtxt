/*
  The HTTP side every hosted provider shares (AssemblyAI, ElevenLabs): one
  call under a deadline, a body read as JSON, and an HTTP status reduced to
  a fixed reason. A provider's body is never read into a message: it may
  echo the request, key and all.
*/
import { SttError } from './types';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure as a fixed reason. The body is not read: it may echo the request. */
export function failure(status: number, call: string): SttError {
  if (status === 401 || status === 403)
    return new SttError('stt_auth', 'unauthorised', false, status, call);
  if (status === 429) return new SttError('stt_failed', 'rate_limited', true, status, call);
  if (status >= 500) return new SttError('stt_failed', 'provider_error', true, status, call);
  if ([400, 413, 415, 422].includes(status)) {
    return new SttError('stt_failed', 'bad_audio', false, status, call);
  }
  return new SttError('stt_failed', 'provider_error', false, status, call);
}

/** A response body as JSON; a malformed one is a provider error, never its text in a message. */
export async function readJson<T>(response: Response, what: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    const timeout =
      (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError';
    throw new SttError(
      'stt_failed',
      timeout ? 'timeout' : 'provider_error',
      true,
      response.status,
      what,
    );
  }
}

/** One call under a deadline. A network error or the deadline is worth another try. */
export async function call(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  what: string,
  ms: number,
) {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SttError('stt_failed', 'timeout', true, undefined, what);
    }
    throw new SttError('stt_failed', 'provider_error', true, undefined, what);
  }
}
