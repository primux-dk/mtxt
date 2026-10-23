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
 * What the poll may load, each only when it needs it: the database once the
 * body and the verifier check out, the settings only to issue a token.
 */
export interface PollDeps {
  adapters: () => Promise<{ db: Db; installId: string }>;
  settings: () => Promise<Settings>;
}

/**
 * The recorder's poll (docs/spec.md "Recorder connection"). The body and the
 * verifier are checked before the database is asked: a malformed body is 400
 * and a verifier that does not hash to the challenge is 410, with no query.
 * The token is made here, sent once, and only its hash reaches the database.
 */
export async function pollForToken(deps: PollDeps, body: unknown): Promise<Response> {
  try {
    return await poll(deps, body);
  } catch (error) {
    return errorResponse(error);
  }
}

async function poll(deps: PollDeps, body: unknown): Promise<Response> {
  const { challenge, verifier } = tokenRequest(body);
  if (!(await verifierMatches(verifier, challenge))) return gone('denied');
  const ctx = await deps.adapters();
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
      const [user, settings] = await Promise.all([
        findUser(ctx.db, ctx.installId, result.userId),
        deps.settings(),
      ]);
      const body: RecorderToken = {
        token,
        token_id: result.tokenId,
        expires_at: result.expiresAt.toISOString(),
        device_name: result.deviceName,
        user: {
          id: result.userId,
          name: user?.name || user?.email || '',
          email: user?.email ?? '',
        },
        install: {
          product_name: settings.productName,
          theme_accent: settings.themeAccent,
          theme_primary: settings.themePrimary,
          interface_language: settings.interfaceLanguage,
          live_transcript_default: settings.liveTranscriptDefault,
        },
      };
      return json(body);
    }
  }
}
