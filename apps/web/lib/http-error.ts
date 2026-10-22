import type { ErrorCode } from '@mtxt/contract';

/** An error with the HTTP status and contract error code it answers with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    /** A contract code, or `install_conflict` for the library's own actions. */
    readonly code: ErrorCode | 'install_conflict',
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
