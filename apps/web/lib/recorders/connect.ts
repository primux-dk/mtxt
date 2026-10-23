import { CHALLENGE_PATTERN, cleanDeviceName, type RecorderGrant } from '@mtxt/adapters';

/** What /connect shows for a challenge, for the signed-in user. */
export type ConnectState =
  /** No grant yet: Approve or Cancel. */
  | 'ask'
  /** Approved, waiting for the recorder's poll. */
  | 'approved'
  /** The recorder has its token. */
  | 'connected'
  | 'denied'
  /** Past its 10 minutes, or another user's challenge: connect again. */
  | 'expired'
  /** The link lacks a well-formed challenge or device name. */
  | 'invalid';

/** The page's two parameters, checked: a challenge and a device name, or null. */
export function connectParams(
  challenge: string | null | undefined,
  name: string | null | undefined,
): { challenge: string; deviceName: string } | null {
  const deviceName = cleanDeviceName(name);
  if (!challenge || !CHALLENGE_PATTERN.test(challenge) || !deviceName) return null;
  return { challenge, deviceName };
}

/**
 * The state for a grant (or none) and the reader. A grant another user holds
 * reads as expired: the page does not say whose it is.
 */
export function connectState(
  grant: Pick<RecorderGrant, 'userId' | 'status' | 'expiresAt'> | undefined,
  userId: string,
  now: Date = new Date(),
): ConnectState {
  if (!grant) return 'ask';
  if (grant.userId !== userId) return 'expired';
  if (grant.status === 'redeemed') return 'connected';
  if (grant.status === 'denied') return 'denied';
  return grant.expiresAt.getTime() > now.getTime() ? 'approved' : 'expired';
}
