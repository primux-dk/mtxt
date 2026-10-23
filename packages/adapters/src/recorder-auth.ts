/**
 * The recorder connection's pure parts (docs/spec.md "Recorder connection"):
 * the token, its hash, the S256 check of a verifier against a challenge, and
 * the poll limit. WebCrypto only, so Workers, Node and a Docker edition run
 * the same code. No database here; src/db/recorders.ts holds the rows.
 */

export const RECORDER_TOKEN_PREFIX = 'mtxt_';
/** `mtxt_` and 32 random bytes in base64url, no padding. */
export const RECORDER_TOKEN_PATTERN = /^mtxt_[A-Za-z0-9_-]{43}$/;
/** base64url SHA-256, no padding (RFC 7636 S256). */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43 to 128 unreserved characters. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export const DEVICE_NAME_MAX = 64;
export const TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
export const GRANT_LIFETIME_MS = 10 * 60 * 1000;
/** One poll per second per grant. */
export const POLL_INTERVAL_MS = 1000;
/** What a 202 asks the recorder to wait before the next poll. */
export const POLL_ADVICE_S = 2;
/** `last_used_at` is written at most this often. */
export const LAST_USED_EVERY_MS = 5 * 60 * 1000;
/** Approved grants not yet exchanged, per user. */
export const MAX_PENDING_GRANTS = 20;
/** Expired grants older than this are deleted when the same user approves or cancels again. */
export const GRANT_KEEP_MS = 24 * 60 * 60 * 1000;

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** A new bearer token. Shown to the recorder once; only its hash is kept. */
export const newRecorderToken = () =>
  RECORDER_TOKEN_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(32)));

/** Lower-case hex SHA-256 of the whole token: what `recorder_tokens.token_hash` holds. */
export const hashRecorderToken = async (token: string) => hex(await digest(token));

/** RFC 7636 S256: base64url SHA-256 of the verifier. */
export const s256 = async (verifier: string) => base64Url(await digest(verifier));

/** Crockford's base32 alphabet: no I, L, O or U, so a code read aloud or retyped stays unambiguous. */
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The pairing code the connect page and the recorder both show, so the user
 * can see that the page belongs to the recorder in front of them. Derived
 * from the challenge alone, so it needs no server state: SHA-256 of the
 * challenge's ASCII bytes, the first 30 bits (the first 4 bytes as a
 * big-endian integer, shifted right by 2), six 5-bit groups from the most
 * significant, each mapped through PAIRING_ALPHABET, shown as `XXX-XXX`.
 */
export async function pairingCode(challenge: string): Promise<string> {
  const bytes = await digest(challenge);
  const bits = (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 2) >>> 0;
  let code = '';
  for (let shift = 25; shift >= 0; shift -= 5) code += PAIRING_ALPHABET[(bits >>> shift) & 31];
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Compares two strings in time that depends only on their length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the verifier is well formed and hashes to the challenge. */
export async function verifierMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER_PATTERN.test(verifier) || !CHALLENGE_PATTERN.test(challenge)) return false;
  return safeEqual(await s256(verifier), challenge);
}

/**
 * The token from an `Authorization` header, or null. The scheme is matched
 * without regard to case (RFC 9110); the token must have the `mtxt_` shape.
 */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^bearer +(\S+) *$/i.exec(header ?? '');
  const token = match?.[1] ?? '';
  return RECORDER_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * A device name as the connect page shows it and the token row keeps it:
 * trimmed, NFC, 1 to 64 characters, no control characters. Null when it is
 * none of that; the recorder shortens a longer name before it opens the page.
 */
export function cleanDeviceName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').normalize('NFC').trim();
  if (!name || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return null;
  return [...name].length <= DEVICE_NAME_MAX ? name : null;
}

/**
 * Whether a poll may go through, given the last one let through. A poll
 * inside POLL_INTERVAL_MS waits; `retryAfter` is whole seconds, at least 1.
 */
export function pollAllowed(
  lastPollAt: number | null,
  now: number,
): { ok: true } | { ok: false; retryAfter: number } {
  if (lastPollAt === null || now - lastPollAt >= POLL_INTERVAL_MS) return { ok: true };
  return {
    ok: false,
    retryAfter: Math.max(1, Math.ceil((lastPollAt + POLL_INTERVAL_MS - now) / 1000)),
  };
}
