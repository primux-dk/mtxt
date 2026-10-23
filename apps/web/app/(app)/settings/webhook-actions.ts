'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { seal } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters, getEnv } from '@/lib/install';
import { fieldMessage } from '@/lib/settings/messages';
import { validateEndpoint, type EndpointField } from '@/lib/settings/validate';
import { isTestMode } from '@/lib/test-mode';
import { endpointRows, type EndpointRow } from '@/lib/webhooks/rows';
import { newEndpointSecret } from '@/lib/webhooks/signature';
import {
  createEndpoint,
  deleteEndpoint,
  queueTestEvent,
  retryNow,
  setEndpointEnabled,
} from '@/lib/webhooks/store';

export type { EndpointRow };

/*
  The settings page's webhook actions (docs/spec.md "Webhooks"). Each one
  checks for an admin itself: a server action is a public endpoint. They
  answer with the server's list, so the screen ends in the server's state
  (behaviour rule 2). The secret leaves the server once, in the answer to
  the add.
*/

export type EndpointsResult =
  | { ok: true; endpoints: EndpointRow[] }
  | { ok: false; endpoints?: EndpointRow[]; message: string };

export type AddResult =
  | { ok: true; endpoints: EndpointRow[]; secret: string; id: string }
  | { ok: false; errors?: Partial<Record<EndpointField, string>>; message?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function admin() {
  const user = await getSessionUser();
  return user?.isAdmin ? user : null;
}

export async function addEndpointAction(value: {
  label: string;
  url: string;
  events: string[];
}): Promise<AddResult> {
  const t = await getTranslations('settings');
  if (!(await admin()))
    return { ok: false, message: (await getTranslations('auth'))('forbidden.body') };
  const checked = validateEndpoint(
    {
      label: String(value.label ?? ''),
      url: String(value.url ?? ''),
      events: Array.isArray(value.events) ? value.events.map(String) : [],
    },
    { allowLocal: await isTestMode() },
  );
  if (!checked.ok) {
    const errors: Partial<Record<EndpointField, string>> = {};
    for (const [field, error] of Object.entries(checked.errors)) {
      errors[field as EndpointField] = fieldMessage(t, error);
    }
    return { ok: false, errors };
  }
  try {
    const env = await getEnv();
    if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not set.');
    const secret = newEndpointSecret();
    const { db, installId } = await getAdapters();
    const created = await createEndpoint(db, installId, {
      label: checked.label,
      url: checked.url,
      events: checked.events,
      sealedSecret: await seal(secret, 'webhook_endpoints.secret', env.SETTINGS_KEY),
    });
    if (!created.ok) return { ok: false, message: t('webhooks.tooMany') };
    revalidatePath('/settings/webhooks');
    return { ok: true, endpoints: await endpointRows(), secret, id: created.id };
  } catch (error) {
    console.error('Could not add the endpoint:', (error as Error).name);
    return { ok: false, message: t('webhooks.addFailed') };
  }
}

async function endpointAction(
  id: string,
  failed: string,
  run: (ctx: Awaited<ReturnType<typeof getAdapters>>) => Promise<void>,
): Promise<EndpointsResult> {
  if (!(await admin()) || !UUID.test(String(id))) return { ok: false, message: failed };
  const ctx = await getAdapters();
  try {
    await run(ctx);
    revalidatePath('/settings/webhooks');
    return { ok: true, endpoints: await endpointRows() };
  } catch (error) {
    console.error('Endpoint change failed:', (error as Error).name);
    return { ok: false, endpoints: await endpointRows().catch(() => undefined), message: failed };
  }
}

/** Sets the value, so a retry changes nothing twice. */
export async function setEndpointEnabledAction(id: string, enabled: boolean) {
  const t = await getTranslations('settings.webhooks');
  return endpointAction(id, t('changeFailed'), async ({ db, installId }) => {
    if (!(await setEndpointEnabled(db, installId, id, Boolean(enabled))))
      throw new Error('No such endpoint');
  });
}

export async function deleteEndpointAction(id: string) {
  const t = await getTranslations('settings.webhooks');
  return endpointAction(id, t('deleteFailed'), ({ db, installId }) =>
    deleteEndpoint(db, installId, id),
  );
}

/** "Send test event": one `webhook.test` delivery, sent by the queue like any other. */
export async function sendTestEventAction(id: string) {
  const t = await getTranslations('settings.webhooks');
  return endpointAction(id, t('testFailed'), async ({ db, installId, queue }) => {
    if ((await queueTestEvent({ db, installId, queue }, id)) === null)
      throw new Error('No such endpoint');
  });
}

/** Retry now, from the delivery log: a pending or parked delivery goes at once. */
export async function retryDeliveryAction(deliveryId: string): Promise<{ ok: boolean }> {
  if (!(await admin()) || !UUID.test(String(deliveryId))) return { ok: false };
  try {
    const { db, installId, queue } = await getAdapters();
    const ok = await retryNow({ db, installId, queue }, deliveryId);
    return { ok };
  } catch (error) {
    console.error('Retry now failed:', (error as Error).name);
    return { ok: false };
  }
}
