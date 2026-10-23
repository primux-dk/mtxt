// Fixture snapshots for the preview pages: every state the main window and
// the live window can be in, with the hard data of behaviour rule 13 (a
// 4-hour recording of 200 MB, a 120-character title, æ, ø and å). People and
// meetings are invented, as in the mockups.

import type { LiveUpdate, QueueItem, Snapshot } from '../src/types';

const now = Date.parse('2026-10-23T09:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

const item = (over: Partial<QueueItem> & Pick<QueueItem, 'id' | 'title' | 'status'>): QueueItem => ({
  started_at: at(2),
  duration_s: 2526,
  size_bytes: 15_200_000,
  reason: null,
  done: 0,
  total: 2,
  server_status: null,
  meeting_url: null,
  active: false,
  ...over,
});

const LONG =
  'Kvartalsgennemgang af produktionslinje 2 med leverandører, kvalitetsafdelingen og økonomi: status, risici og næste skridt';

export const figure05: QueueItem[] = [
  item({ id: 'a', title: 'Produktionsmøde', status: 'uploading', done: 2, total: 5, active: true, duration_s: 2400, size_bytes: 38_000_000 }),
  item({ id: 'b', title: 'Leverancer', status: 'confirmed', meeting_url: 'https://app.mtxt.co/meetings/b', started_at: at(26) }),
  item({ id: 'c', title: 'Plan for november', status: 'pending', reason: { kind: 'network' }, started_at: at(5) }),
  item({ id: 'd', title: 'Opfølgning, linje 2', status: 'warn', reason: { kind: 'network' }, started_at: at(30) }),
];

export const hard: QueueItem[] = [
  item({ id: 'h1', title: LONG, status: 'uploading', done: 7, total: 24, active: true, duration_s: 14_400, size_bytes: 200_000_000, started_at: at(5) }),
  item({ id: 'h2', title: 'Workshop: Ærø-færgen og årsplanen', status: 'confirmed', server_status: 'transcribed', meeting_url: 'https://app.mtxt.co/meetings/h2' }),
  item({ id: 'h3', title: 'Salgsmøde', status: 'pending', reason: { kind: 'server' } }),
  item({ id: 'h4', title: 'Budget 2027', status: 'pending', reason: { kind: 'rejected', code: 'too_large' } }),
  item({ id: 'h5', title: 'Morgenmøde', status: 'pending', reason: { kind: 'rejected', code: 'file_missing' } }),
  item({ id: 'h6', title: 'Rekruttering', status: 'ask_user', reason: { kind: 'network' }, started_at: at(24 * 8) }),
  item({ id: 'h7', title: 'Bestyrelsesmøde', status: 'deleted', meeting_url: 'https://app.mtxt.co/meetings/h7', started_at: at(24 * 9) }),
  item({ id: 'h8', title: 'Kundebesøg', status: 'saved_elsewhere', started_at: at(24 * 10) }),
];

const base: Snapshot = {
  phase: 'ready',
  host: 'https://app.mtxt.co',
  host_label: 'app.mtxt.co',
  pairing_code: null,
  connect_error: null,
  connection: {
    product_name: 'Primux Møder',
    theme_accent: '#566b45',
    theme_primary: '#111111',
    user_name: 'Mette Lund',
    device_name: 'Mettes MacBook Pro',
  },
  signed_out: false,
  language: 'en',
  permissions: { microphone: 'granted', system_audio: 'granted' },
  permissions_asked: true,
  recording: null,
  queue: [],
  online: true,
  live: {
    enabled: true,
    model: 'parakeet',
    models: [
      { id: 'parakeet', label: 'Parakeet', size: 670_619_803, downloaded: true, download: null },
      { id: 'whisper', label: 'Whisper', size: 574_041_195, downloaded: false, download: null },
    ],
    hidden: false,
    running: false,
  },
  ask: null,
  notice: null,
  version: '0.2.0',
};

const recording = {
  id: 'r',
  title: 'Produktionsmøde, uge 43',
  started_at: at(0.3),
  elapsed_s: 1122,
  sources: { microphone: 'on', system_audio: 'on' },
  stopping: false,
  starting: false,
};

export const states: Record<string, Partial<Snapshot>> = {
  setup: { phase: 'setup', host: null, host_label: null, connection: null },
  'setup-error': {
    phase: 'setup',
    connection: null,
    connect_error: { key: 'recorder.connect.failed', args: { host: 'moeder.eksempel.dk' } },
    host_label: 'moeder.eksempel.dk',
  },
  connecting: { phase: 'connecting', connection: null, pairing_code: '1MM-SP7' },
  empty: { queue: [], live: { ...base.live, enabled: false } },
  permissions: { permissions: { microphone: 'not_determined', system_audio: 'not_determined' }, permissions_asked: false },
  denied: { permissions: { microphone: 'denied', system_audio: 'denied' } },
  figure05: { recording, queue: figure05, live: { ...base.live, running: true } },
  uploading: { queue: figure05 },
  offline: { online: false, queue: [item({ id: 'o', title: 'Plan for november', status: 'pending', reason: { kind: 'network' } }), ...figure05.slice(1, 2)] },
  'signed-out': {
    signed_out: true,
    queue: [item({ id: 's', title: 'Plan for november', status: 'pending', reason: { kind: 'signed_out' } }), ...figure05.slice(1, 2)],
  },
  hard: { queue: hard, live: { ...base.live, model: 'whisper', models: [base.live.models[0]!, { ...base.live.models[1]!, download: { done: 241_000_000, total: 574_041_195, failed: false } }] } },
  ask: { queue: hard.slice(5, 6).concat(figure05.slice(1, 2)), ask: hard[5]! },
  'mic-only': { recording: { ...recording, sources: { microphone: 'on', system_audio: 'off' } }, permissions: { microphone: 'granted', system_audio: 'denied' }, queue: figure05.slice(1, 2) },
};

export function snapshot(name: string, lang: string): Snapshot {
  return { ...base, ...(states[name] ?? {}), language: lang === 'da' ? 'da' : 'en' };
}

export const live: Record<string, LiveUpdate> = {
  listening: {
    state: 'listening',
    lines: ['Vi mangler stadig at teste det nye skift.'],
    partial: 'Jeg tager testen torsdag. Hvis kvaliteten holder, kan vi starte mandag.',
  },
  loading: { state: 'loading', lines: [], partial: '' },
  paused: { state: 'paused', lines: [], partial: '' },
  'needs-model': { state: 'needs_model', lines: [], partial: '' },
  error: { state: 'error', lines: [], partial: '' },
};
