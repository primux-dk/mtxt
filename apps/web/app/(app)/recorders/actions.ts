'use server';

import { listRecorderTokens, revokeRecorderToken } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';

/** A connected recorder as the Recorders dialog shows it. Dates as ISO strings. */
export interface RecorderRow {
  id: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type RecordersResult = { ok: true; recorders: RecorderRow[] } | { ok: false };
export type DisconnectResult = { ok: true } | { ok: false; code: 'not_found' | 'server' };

/** The signed-in user's own working recorders. Nobody else's, admins included. */
export async function listMyRecorders(): Promise<RecordersResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false };
  try {
    const { db, installId } = await getAdapters();
    const rows = await listRecorderTokens(db, installId, user.id);
    return {
      ok: true,
      recorders: rows.map((r) => ({
        id: r.id,
        deviceName: r.deviceName,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      })),
    };
  } catch (error) {
    console.error('Could not list recorders:', (error as Error).name);
    return { ok: false };
  }
}

/**
 * Disconnect: revokes one of the user's own tokens at once. Sets a value, so
 * a retry after a lost answer is a success that writes nothing (behaviour.md
 * rule 2).
 */
export async function disconnectRecorder(tokenId: string): Promise<DisconnectResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, code: 'server' };
  try {
    const { db, installId } = await getAdapters();
    const result = await revokeRecorderToken(db, installId, { userId: user.id, tokenId });
    return result === 'not_found' ? { ok: false, code: 'not_found' } : { ok: true };
  } catch (error) {
    console.error('Could not disconnect a recorder:', (error as Error).name);
    return { ok: false, code: 'server' };
  }
}
