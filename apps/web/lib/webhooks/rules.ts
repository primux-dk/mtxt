/*
  The webhook rules that need no database (docs/spec.md "Webhooks"): which
  meeting may be sent, the retry schedule, the limits. Imported by the queue
  consumer, which wrangler bundles, so nothing here may need Next.js.
*/
import type { Visibility, WebhookAutoSend, WebhookEvent } from '@mtxt/adapters';

/** Waits after a failed attempt 1, 2, 3, 4 and 5; the sixth failure parks the delivery. */
export const BACKOFF_S = [60, 600, 3600, 21_600, 86_400] as const;
export const MAX_ATTEMPTS = BACKOFF_S.length + 1;
/** The longest delay a queue message takes (Cloudflare Queues: 12 hours); a longer wait is two hops. */
export const QUEUE_MAX_DELAY_S = 43_200;
/** How long one attempt holds a delivery: the 10-second request and room around it. */
export const ATTEMPT_LEASE_MS = 60_000;
export const SEND_TIMEOUT_MS = 10_000;
export const MAX_ENDPOINTS = 5;
export const MAX_URL_LENGTH = 2048;
export const MAX_LABEL_LENGTH = 40;
/** A saved recap is sent this long after the save, so one typing session is one event. */
export const SAVED_DELAY_S = 60;
/** A signed export link's lifetime. */
export const LINK_TTL_S = 3600;
/** The delivery log shows this many. */
export const LOG_SIZE = 50;
/** A consumer should refuse a signature older than this. */
export const SIGNATURE_TOLERANCE_S = 300;

/**
 * Seconds to wait after attempt `attempt` failed, or null when that was the
 * last one and the delivery is parked. Retry now may take a parked delivery
 * past MAX_ATTEMPTS; each of those gets one try.
 */
export function backoffAfter(attempt: number): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  return BACKOFF_S[Math.max(0, attempt - 1)]!;
}

/**
 * Whether a meeting may go to the install's endpoints now: not deleted, and
 * either its owner gave consent or "Send automatically" covers its
 * visibility. Private is never covered automatically.
 */
export function mayBeSent(
  meeting: {
    visibility: Visibility;
    deletedAt?: Date | null;
    webhookConsentAt?: Date | null;
  },
  autoSend: WebhookAutoSend,
): boolean {
  if (meeting.deletedAt) return false;
  if (meeting.webhookConsentAt) return true;
  if (meeting.visibility === 'company') return autoSend === 'company' || autoSend === 'shared';
  if (meeting.visibility === 'shared') return autoSend === 'shared';
  return false;
}

/**
 * The name on the owner's action: "Send to <label>" when every enabled
 * endpoint that has a label has the same one, else null ("Send to connected
 * systems").
 */
export function connectedLabel(endpoints: { label: string | null; enabled: boolean }[]) {
  const labels = new Set(
    endpoints.filter((e) => e.enabled && e.label?.trim()).map((e) => e.label!.trim()),
  );
  return labels.size === 1 ? [...labels][0]! : null;
}

/** Whether an endpoint takes an event. */
export const takes = (endpoint: { events: readonly string[] }, event: WebhookEvent) =>
  endpoint.events.includes(event);
