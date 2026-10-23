import 'server-only';
import {
  CHALLENGE_PATTERN,
  findUser,
  hashRecorderToken,
  newRecorderToken,
  pollGrant,
  POLL_ADVICE_S,
  VERIFIER_PATTERN,
  verifierMatches,
  type Db,
  type Settings,
} from '@mtxt/adapters';
import type { RecorderToken } from '@mtxt/contract';
import { errorResponse, json } from '../api';
import { HttpError } from '../http-error';

/** A body that is an object with a well-formed challenge and verifier, else 400. */
export function tokenRequest(body: unknown): { challenge: string; verifier: string } {
  const { challenge, verifier } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof challenge !== 'string' ||
    !CHALLENGE_PATTERN.test(challenge) ||
    typeof verifier !== 'string' ||
    !VERIFIER_PATTERN.test(verifier)
  ) {
    throw new HttpError(
      400,
      'invalid_request',
      'Send the challenge (43 base64url characters) and its verifier (43 to 128 characters).',
    );
  }
  return { challenge, verifier };
}

const gone = (code: 'expired' | 'denied') =>
  json(
    {
      error: {
        code,
        message:
          code === 'expired'
            ? 'This connection expired or was already used. Open the recorder and connect again.'
            : 'This connection was not approved. Open the recorder and connect again.',
      },
    },
    410,
  );

/**
 * The recorder's poll (docs/spec.md "Recorder connection"). A verifier that
 * does not hash to the challenge is 410 before the database is asked. The
 * token is made here, sent once, and only its hash reaches the database.
 */
export async function pollForToken(
  ctx: { db: Db; installId: string; settings: Settings },
  body: unknown,
): Promise<Response> {
  try {
    return await poll(ctx, body);
  } catch (error) {
    return errorResponse(error);
  }
}

async function poll(
  ctx: { db: Db; installId: string; settings: Settings },
  body: unknown,
): Promise<Response> {
  const { challenge, verifier } = tokenRequest(body);
  if (!(await verifierMatches(verifier, challenge))) return gone('denied');
  const token = newRecorderToken();
  const result = await pollGrant(ctx.db, ctx.installId, {
    challenge,
    tokenHash: await hashRecorderToken(token),
  });
  switch (result.kind) {
    case 'pending':
      return json({ status: 'pending' }, 202, { 'retry-after': String(POLL_ADVICE_S) });
    case 'rate_limited':
      return json(
        {
          error: { code: 'rate_limited', message: 'One poll a second.' },
          retry_after: result.retryAfter,
        },
        429,
        { 'retry-after': String(result.retryAfter) },
      );
    case 'expired':
    case 'denied':
      return gone(result.kind);
    case 'token': {
      const user = await findUser(ctx.db, ctx.installId, result.userId);
      const body: RecorderToken = {
        token,
        token_id: result.tokenId,
        expires_at: result.expiresAt.toISOString(),
        device_name: result.deviceName,
        user: { name: user?.name || user?.email || '' },
        install: {
          product_name: ctx.settings.productName,
          theme_accent: ctx.settings.themeAccent,
          theme_primary: ctx.settings.themePrimary,
        },
      };
      return json(body);
    }
  }
}
