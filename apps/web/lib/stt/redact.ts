/*
  Log redaction. Provider errors are already reduced to fixed reasons
  (lib/stt/types.ts); this is the second line for anything else that gets
  logged, an unexpected error's message or stack. It strips every secret
  this isolate opened (the API key, the webhook secret) and anything that
  looks like a bearer token or an authorization header.
*/
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

/** An unknown error as one redacted log string. */
export const describeError = (error: unknown) =>
  redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
