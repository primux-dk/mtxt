'use server';

import { redirect } from 'next/navigation';
import { approveGrant, denyGrant } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';
import { connectParams } from '@/lib/recorders/connect';

/** What the connect form shows when an action did not go through. */
export type ConnectFormState = { error: 'too_many' | 'invalid' | 'signed_out' | 'server' } | null;

const back = (challenge: string, deviceName: string) =>
  `/connect?${new URLSearchParams({ challenge, name: deviceName })}`;

/**
 * Approve and Cancel on /connect. Server actions, so Next.js checks the
 * request's Origin against the host (CSRF). Each writes the grant once and
 * sends the reader back to the same address, where the page shows what the
 * grant now says.
 */
async function decide(kind: 'approve' | 'deny', form: FormData): Promise<ConnectFormState> {
  const params = connectParams(String(form.get('challenge') ?? ''), String(form.get('name') ?? ''));
  if (!params) return { error: 'invalid' };
  const user = await getSessionUser();
  if (!user) return { error: 'signed_out' };
  try {
    const { db, installId } = await getAdapters();
    const input = { challenge: params.challenge, userId: user.id, deviceName: params.deviceName };
    const result =
      kind === 'approve'
        ? await approveGrant(db, installId, input)
        : await denyGrant(db, installId, input);
    if (result === 'too_many') return { error: 'too_many' };
  } catch (error) {
    console.error('Could not store the recorder grant:', (error as Error).name);
    return { error: 'server' };
  }
  redirect(back(params.challenge, params.deviceName));
}

export async function approveConnection(_previous: ConnectFormState, form: FormData) {
  return decide('approve', form);
}

export async function cancelConnection(_previous: ConnectFormState, form: FormData) {
  return decide('deny', form);
}
