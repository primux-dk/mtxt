import type { ErrorCode } from '@mtxt/contract';

/** An error with the HTTP status and contract error code it answers with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
