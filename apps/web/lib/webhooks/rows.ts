import 'server-only';
import type { WebhookDelivery } from '@mtxt/adapters';
import { getAdapters } from '../install';
import { lastDeliveries, listEndpoints } from './store';

/** An endpoint as the settings list shows it, with its newest delivery. Never the secret. */
export interface EndpointRow {
  id: string;
  label: string | null;
  url: string;
  events: string[];
  enabled: boolean;
  last: {
    status: WebhookDelivery['status'];
    attempts: number;
    code: number | null;
    error: string | null;
    at: string;
  } | null;
}

/** For admin pages and actions only: the caller has checked the admin. */
export async function endpointRows(): Promise<EndpointRow[]> {
  const { db, installId } = await getAdapters();
  const [endpoints, last] = await Promise.all([
    listEndpoints(db, installId),
    lastDeliveries(db, installId),
  ]);
  return endpoints.map((e) => {
    const l = last.get(e.id);
    return {
      id: e.id,
      label: e.label,
      url: e.url,
      events: [...e.events],
      enabled: e.enabled,
      last: l
        ? {
            status: l.status,
            attempts: l.attempts,
            code: l.last_status_code,
            error: l.last_error,
            at: new Date(l.last_attempt_at ?? l.created_at).toISOString(),
          }
        : null,
    };
  });
}
