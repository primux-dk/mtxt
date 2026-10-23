/*
  The signature on every webhook request (docs/spec.md "Webhooks"):
  `X-Mtxt-Signature: t=<unix seconds>,v1=<hex>`, the hex being HMAC-SHA256
  with the endpoint's secret over `<t>.<raw body>`. The timestamp is inside
  the signed text, so a captured request cannot be replayed with a new one.
  WebCrypto only: the same code runs in the Worker and in a consumer.
*/
import { SIGNATURE_TOLERANCE_S } from './rules';

export const SIGNATURE_HEADER = 'X-Mtxt-Signature';
export const EVENT_HEADER = 'X-Mtxt-Event';
export const DELIVERY_HEADER = 'X-Mtxt-Delivery';

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);

/** The header value for a body sent at `t` (unix seconds). */
export async function signatureHeader(secret: string, body: string, t: number): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    encoder.encode(`${t}.${body}`),
  );
  return `t=${t},v1=${hex(mac)}`;
}

/**
 * What a consumer does: parse the header, refuse a timestamp outside the
 * tolerance, and compare the MAC in constant time (WebCrypto's verify).
 */
export async function verifySignature(
  header: string | null,
  secret: string,
  body: string,
  now = Math.floor(Date.now() / 1000),
  toleranceS = SIGNATURE_TOLERANCE_S,
): Promise<boolean> {
  const parts = Object.fromEntries(
    (header ?? '').split(',').map((part) => part.trim().split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now - t) > toleranceS) return false;
  const mac = Uint8Array.from(v1.match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    mac,
    encoder.encode(`${t}.${body}`),
  );
}

/** A new endpoint's secret: `whsec_` and 32 random bytes, base64url. */
export function newEndpointSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `whsec_${b64}`;
}
