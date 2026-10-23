/*
  The locale keys the settings list and the delivery log say an event, a
  status and an answer with, under `settings.webhooks`. One mapping, so a
  delivery reads the same on both screens (behaviour rule 7).
*/
export const EVENT_KEYS = {
  'meeting.transcribed': 'transcribed',
  'recap.drafted': 'drafted',
  'recap.saved': 'saved',
  'meeting.shared': 'shared',
  'meeting.deleted': 'deleted',
  'webhook.test': 'test',
} as const;
export type EventKey = (typeof EVENT_KEYS)[keyof typeof EVENT_KEYS];

export const eventKey = (event: string): EventKey =>
  EVENT_KEYS[event as keyof typeof EVENT_KEYS] ?? 'test';

/** A delivery's status word: a pending one that has not been tried yet is "Queued". */
export function statusKey(status: string, attempts: number) {
  if (status === 'pending') return attempts === 0 ? 'queued' : 'pending';
  if (['sending', 'delivered', 'parked', 'cancelled'].includes(status))
    return status as 'sending' | 'delivered' | 'parked' | 'cancelled';
  return 'pending';
}

const ANSWERS = [
  'http_status',
  'redirect',
  'timeout',
  'network',
  'private_address',
  'dns',
  'config',
  'not_eligible',
  'meeting_gone',
  'endpoint_disabled',
] as const;
export type AnswerKey = (typeof ANSWERS)[number] | 'ok' | 'none';

/** The last answer: a 2xx, a fixed failure reason, or nothing yet. */
export function answerKey(error: string | null, code: number | null): AnswerKey {
  if (error && (ANSWERS as readonly string[]).includes(error)) return error as AnswerKey;
  if (code !== null) return 'ok';
  return 'none';
}
