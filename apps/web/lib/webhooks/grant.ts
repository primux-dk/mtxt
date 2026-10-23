/*
  Signed export links (docs/spec.md "Webhooks", Links). A token is a
  meeting-scoped, format-scoped grant for one endpoint, valid one hour:

    v1.<meeting id>.<format>.<expiry, unix seconds>.<endpoint id>.<signature>

  The signature is HMAC-SHA256 over everything before it, under a key
  derived from SETTINGS_KEY for this one use, so the token needs no
  database row and a token made for one meeting or format opens nothing
  else. The export route checks the permission state again at fetch time.
*/
import { b64url, derivedKey, fromB64url } from '../derived-key';
import { LINK_TTL_S } from './rules';

export const GRANT_FORMATS = ['transcript', 'md', 'docx'] as const;
export type GrantFormat = (typeof GRANT_FORMATS)[number];

export interface Grant {
  meetingId: string;
  format: GrantFormat;
  endpointId: string;
  /** Unix seconds. */
  expiresAt: number;
}

const encoder = new TextEncoder();
/** Ids in a token: the app's UUIDs, and the seed's and the tests' shorter ones. No dots. */
const ID = '[A-Za-z0-9-]{1,64}';
const TOKEN = new RegExp(
  `^v1\\.(${ID})\\.(transcript|md|docx)\\.(\\d{1,12})\\.(${ID})\\.([A-Za-z0-9_-]{43})$`,
);

/** The grant key: its own label under SETTINGS_KEY, so no other use of the key signs the same. */
const grantKey = (settingsKey: string, usage: 'sign' | 'verify') =>
  derivedKey(settingsKey, 'mtxt:export-grant:v1', usage);

const body = (g: Grant) => `v1.${g.meetingId}.${g.format}.${g.expiresAt}.${g.endpointId}`;

export async function createGrant(settingsKey: string, grant: Grant): Promise<string> {
  if (!new RegExp(`^${ID}$`).test(grant.meetingId) || !new RegExp(`^${ID}$`).test(grant.endpointId))
    throw new Error('Not an id a grant can carry.');
  const mac = await crypto.subtle.sign(
    'HMAC',
    await grantKey(settingsKey, 'sign'),
    encoder.encode(body(grant)),
  );
  return `${body(grant)}.${b64url(mac)}`;
}

/** A grant for each format, valid LINK_TTL_S from `now`. */
export function grantExpiry(now: Date): number {
  return Math.floor(now.getTime() / 1000) + LINK_TTL_S;
}

export type GrantCheck = { ok: true; grant: Grant } | { ok: false; reason: 'invalid' | 'expired' };

/** Reads a token: invalid (any change, any other key) or expired, else the grant. */
export async function readGrant(
  settingsKey: string,
  token: string,
  now = new Date(),
): Promise<GrantCheck> {
  const match = TOKEN.exec(token);
  if (!match) return { ok: false, reason: 'invalid' };
  const [, meetingId, format, expiry, endpointId, signature] = match;
  const grant: Grant = {
    meetingId: meetingId!,
    format: format as GrantFormat,
    expiresAt: Number(expiry),
    endpointId: endpointId!,
  };
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await grantKey(settingsKey, 'verify'),
      fromB64url(signature!),
      encoder.encode(body(grant)),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'invalid' };
  if (grant.expiresAt * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, grant };
}
