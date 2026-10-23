/*
  Log redaction, one implementation for the queue router and the
  transcription code (docs/decisions.md, packet 4 review). A logged error is
  reduced to its name, a fixed class and an HTTP status; its own message and
  stack, which may echo a provider's response and the key in it, appear only
  in the e2e bundle, and even then with every remembered secret, bearer token
  and authorization header stripped.
*/

/** "1" when wrangler bundles the e2e Worker (`--define`); see apps/web/wrangler.jsonc. */
declare const MTXT_E2E_BUILD: string | undefined;

const secrets = new Set<string>();

/** Called where a secret is opened, so a later log line can never carry it. */
export function rememberSecret(value: string) {
  if (value.length >= 6) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|x-mtxt-webhook-secret)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1$2[redacted]',
    );
}

/**
 * An error as one log string: the name, the class (an error's own `reason`
 * when it carries one, such as the speech-to-text errors, else `unexpected`)
 * and the HTTP status if any. Nothing else outside the e2e bundle.
 */
export function describeError(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown;
    reason?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const name = typeof e.name === 'string' && /^\w{1,40}$/.test(e.name) ? e.name : 'Error';
  const kind =
    typeof e.reason === 'string' && /^[a-z_]{1,40}$/.test(e.reason) ? e.reason : 'unexpected';
  const status =
    typeof e.status === 'number' && Number.isInteger(e.status) ? ` (HTTP ${e.status})` : '';
  const line = `${name}: ${kind}${status}`;
  if (typeof MTXT_E2E_BUILD !== 'undefined' && MTXT_E2E_BUILD === '1') {
    return `${line}; ${redact(typeof e.message === 'string' ? e.message : String(error))}`;
  }
  return line;
}
