// The main window: connect, record, the upload queue, the live switch and
// the model picker. It renders the snapshot Rust sends after every change and
// sends commands back; it keeps no state of its own beyond what is on screen.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { clock, dateTime, duration, initials, size } from './format';
import { setLanguage, t, translate, type Args } from './locale';
import { applyTheme } from './theme';
import type { Notice, QueueItem, Snapshot } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let snap: Snapshot | null = null;
let titleTouched = false;
let pendingStart = false;
const askDismissed = new Set<string>();
let modelAsked: string | null = null;

// ---------- small helpers ----------

function notice(n: Notice | null | undefined): string {
  return n ? t(n.key, n.args as Args) : '';
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Open a dialog modally and give focus back to what opened it (rule 11). */
function openDialog(d: HTMLDialogElement, focus?: HTMLElement): void {
  if (d.open) return;
  const opener = document.activeElement as HTMLElement | null;
  d.addEventListener('close', () => opener?.focus?.(), { once: true });
  d.showModal();
  focus?.focus();
}

function product(): string {
  return snap?.connection?.product_name ?? 'mtxt Recorder';
}

function defaultTitle(): string {
  return t('recorder.title.default', { date: dateTime(new Date()) });
}

// ---------- rendering ----------

function render(s: Snapshot): void {
  snap = s;
  setLanguage(s.language);
  translate();
  applyTheme(s.connection?.theme_accent, s.connection?.theme_primary);
  document.title = product();
  document.querySelectorAll<HTMLElement>('[data-product]').forEach((n) => (n.textContent = product()));
  $('setup').hidden = s.phase !== 'setup';
  $('connecting').hidden = s.phase !== 'connecting';
  $('ready').hidden = s.phase !== 'ready';
  if (s.phase === 'setup') renderSetup(s);
  if (s.phase === 'connecting') renderConnecting(s);
  if (s.phase === 'ready') renderReady(s);
  renderAsk(s);
}

function renderSetup(s: Snapshot): void {
  const host = $<HTMLInputElement>('host');
  if (!host.value && s.host_label) host.value = s.host_label;
  const err = $('connect-error');
  err.textContent = notice(s.connect_error);
  err.hidden = !s.connect_error;
}

function renderConnecting(s: Snapshot): void {
  $('connect-instructions').textContent = t('recorder.connect.instructions', { host: s.host_label ?? '' });
  $('pairing-code').textContent = s.pairing_code ?? '';
}

function renderReady(s: Snapshot): void {
  renderBanners(s);
  const rec = s.recording;
  const title = $<HTMLInputElement>('title');
  if (rec) {
    title.value = rec.title;
    title.readOnly = true;
  } else {
    title.readOnly = false;
    if (!titleTouched) title.value = defaultTitle();
  }
  const button = $<HTMLButtonElement>('record');
  button.dataset.state = rec ? 'recording' : 'idle';
  button.setAttribute('aria-label', t(rec ? 'recorder.stop' : 'recorder.record'));
  button.title = t(rec ? 'recorder.stop' : 'recorder.record');
  button.disabled = !!rec && (rec.starting || rec.stopping);
  const state = $('record-state');
  state.replaceChildren();
  if (rec) {
    const key = rec.stopping
      ? 'recorder.stopping'
      : rec.starting
        ? 'recorder.starting'
        : rec.sources.microphone === 'on' && rec.sources.system_audio === 'on'
          ? 'recorder.capturing'
          : rec.sources.microphone === 'on'
            ? 'recorder.capturingMicOnly'
            : 'recorder.capturingSystemOnly';
    state.append(el('span', { className: 'dot' }), t(key));
    $('clock').textContent = clock(rec.elapsed_s);
  } else {
    state.textContent = t('recorder.ready');
    $('clock').textContent = clock(0);
    ($('mic-level') as HTMLMeterElement).value = 0;
    ($('sys-level') as HTMLMeterElement).value = 0;
  }
  renderPermissions(s);
  const toggle = $('live-toggle');
  toggle.setAttribute('aria-pressed', String(s.live.enabled));
  $('show-live').hidden = !(s.live.enabled && rec && (s.live.hidden || !s.live.running));
  renderQueue(s);
  renderFooter(s);
}

function renderBanners(s: Snapshot): void {
  const box = $('banners');
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
  box.replaceChildren();
  const banner = (kind: 'warn' | '', iconName: string, text: string, action?: [string, () => void], key?: string) => {
    const b = el('div', { className: `banner ${kind}` });
    b.setAttribute('role', kind ? 'alert' : 'status');
    const body = el('span', { className: 'banner-text' }, text);
    if (action) {
      const btn = el('button', { type: 'button', className: 'text-btn', textContent: action[0] });
      btn.dataset.focusKey = key ?? action[0];
      btn.addEventListener('click', action[1]);
      body.append(' ', btn);
    }
    b.append(icon(iconName), body);
    box.append(b);
  };
  if (s.notice) {
    banner('warn', 'warning', notice(s.notice), [t('common.close'), () => invoke('dismiss_notice')], 'notice');
  }
  if (s.signed_out) {
    banner('warn', 'warning', t('recorder.signedOut', { product: product() }), [t('recorder.connect.again'), connectAgain], 'signedout');
  } else if (!s.online && s.queue.some((q) => q.reason?.kind === 'network')) {
    banner('', 'network', t('recorder.network.offline', { host: s.host_label ?? '' }));
  }
  if (focusKey) box.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
}

function renderPermissions(s: Snapshot): void {
  const box = $('permissions');
  const p = s.permissions;
  const undetermined = p.microphone === 'not_determined' || p.system_audio === 'not_determined';
  const denied = (['microphone', 'system_audio'] as const).filter((k) => p[k] === 'denied');
  const unsupported = p.system_audio === 'unsupported';
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
  box.replaceChildren();
  if (pendingStart && undetermined) {
    const cont = el('button', { type: 'button', className: 'btn small', textContent: t('recorder.permission.continue') });
    cont.dataset.focusKey = 'perm-continue';
    cont.addEventListener('click', askPermissions);
    box.append(
      el('h2', { textContent: t('recorder.permission.heading') }),
      el('p', { className: 'muted', textContent: t('recorder.permission.intro') }),
      el('ul', {}, el('li', { textContent: t('recorder.permission.mic.explain') }), el('li', { textContent: t('recorder.permission.system.explain') })),
      el('div', { className: 'row' }, cont),
    );
  }
  for (const which of denied) {
    const open = el('button', { type: 'button', className: 'btn small', textContent: t('recorder.permission.openSettings') });
    open.dataset.focusKey = `open-${which}`;
    open.addEventListener('click', () => invoke('open_settings', { which }));
    box.append(
      el('div', { className: 'permission-denied' }, icon('warning'), el('span', { textContent: t(which === 'microphone' ? 'recorder.permission.mic.denied' : 'recorder.permission.system.denied') })),
      el('div', { className: 'row' }, open),
    );
  }
  if (denied.length) {
    const again = el('button', { type: 'button', className: 'btn quiet small', textContent: t('recorder.permission.recheck') });
    again.dataset.focusKey = 'recheck';
    again.addEventListener('click', () => invoke('refresh'));
    box.lastElementChild?.append(again);
  }
  if (unsupported) {
    box.append(el('div', { className: 'permission-denied muted' }, icon('info'), el('span', { textContent: t('recorder.permission.system.unsupported') })));
  }
  box.hidden = box.childElementCount === 0;
  if (focusKey) box.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
}

interface StatusView {
  icon: string;
  cls: string;
  text: string;
  action?: () => void;
}

export function statusOf(q: QueueItem): StatusView {
  const reason = q.reason;
  const rejected = (): StatusView =>
    reason?.kind === 'rejected' && reason.code === 'file_missing'
      ? { icon: 'warning', cls: 'warn', text: t('recorder.queue.fileMissing'), action: () => invoke('remove_recording', { id: q.id }) }
      : { icon: 'warning', cls: 'warn', text: t('recorder.queue.rejected') };
  switch (q.status) {
    case 'recording':
      return { icon: 'dot', cls: 'warn', text: t('recorder.queue.recording') };
    case 'uploading':
      return { icon: 'upload', cls: '', text: t('recorder.queue.uploading', { done: q.done, total: q.total }) };
    case 'pending':
    case 'warn':
      if (reason?.kind === 'rejected') return rejected();
      if (reason?.kind === 'signed_out') return { icon: 'warning', cls: 'warn', text: t('recorder.queue.signedOut'), action: connectAgain };
      if (q.status === 'warn') return { icon: 'warning', cls: 'warn', text: t('recorder.queue.warn24h'), action: () => invoke('try_now', { id: q.id }) };
      if (reason?.kind === 'server') return { icon: 'network', cls: 'muted', text: t('recorder.queue.pendingServer') };
      return { icon: 'network', cls: 'muted', text: t('recorder.queue.pendingNetwork') };
    case 'ask_user':
      return { icon: 'warning', cls: 'warn', text: t('recorder.queue.ask7d'), action: () => openAsk(q, true) };
    case 'confirmed':
      return { icon: 'check', cls: 'accent-fg', text: t(q.server_status === 'transcribed' ? 'recorder.queue.transcribed' : 'recorder.queue.confirmed') };
    case 'deleted':
      return { icon: 'check', cls: 'muted', text: t('recorder.queue.deleted') };
    case 'saved_elsewhere':
      return { icon: 'check', cls: 'muted', text: t('recorder.queue.savedElsewhere') };
  }
}

function renderQueue(s: Snapshot): void {
  const list = $('queue-list');
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
  list.replaceChildren();
  for (const q of s.queue) {
    const meta = [q.title, dateTime(q.started_at), q.duration_s ? duration(q.duration_s) : '', q.size_bytes ? size(q.size_bytes) : '']
      .filter(Boolean)
      .join(' · ');
    let titleNode: HTMLElement;
    if (q.meeting_url) {
      const b = el('button', { type: 'button', className: 'queue-title', textContent: q.title, title: meta });
      b.setAttribute('aria-label', t('recorder.queue.open', { title: q.title }));
      b.dataset.focusKey = `open-${q.id}`;
      b.addEventListener('click', () => invoke('open_url', { url: q.meeting_url }));
      titleNode = b;
    } else {
      titleNode = el('span', { className: 'queue-title', textContent: q.title, title: meta });
    }
    titleNode.lang = '';
    const v = statusOf(q);
    const status = el('span', { className: `queue-status ${v.cls}` }, icon(v.icon));
    if (v.action) {
      const b = el('button', { type: 'button', className: 'queue-action', textContent: v.text, title: v.text });
      b.dataset.focusKey = `act-${q.id}`;
      b.addEventListener('click', v.action);
      status.append(b);
    } else {
      status.append(el('span', { textContent: v.text, title: v.text }));
    }
    list.append(el('li', { className: 'queue-row' }, titleNode, status));
  }
  $('queue-count').textContent = s.queue.length ? t('recorder.queue.count', { count: s.queue.length }) : '';
  $('queue-empty').hidden = s.queue.length > 0;
  if (focusKey) list.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
}

function renderFooter(s: Snapshot): void {
  const name = s.connection?.user_name ?? '';
  $('avatar').textContent = initials(name);
  $('user-name').textContent = name;
  $('connected-mark').title = t('recorder.connected', { name });
  $('connected-mark').hidden = s.signed_out;
  const select = $<HTMLSelectElement>('model');
  const focused = document.activeElement === select;
  select.replaceChildren();
  for (const m of s.live.models) {
    const key = m.download && !m.download.failed
      ? 'recorder.model.downloading'
      : m.download?.failed
        ? 'recorder.model.failed'
        : m.downloaded
          ? 'recorder.model.downloaded'
          : 'recorder.model.download';
    const percent = m.download ? Math.floor((100 * m.download.done) / Math.max(1, m.download.total)) : 0;
    select.append(el('option', { value: m.id, textContent: t(key, { model: m.label, percent }) }));
  }
  select.value = s.live.model;
  if (focused) select.focus();
  const busy = s.live.models.find((m) => m.download && !m.download.failed);
  const progress = $('model-progress');
  progress.hidden = !busy;
  if (busy?.download) {
    progress.textContent = t('recorder.model.progress', { model: busy.label, done: size(busy.download.done), total: size(busy.download.total) });
  }
}

function renderAsk(s: Snapshot): void {
  const d = $<HTMLDialogElement>('ask-dialog');
  if (s.ask && !askDismissed.has(s.ask.id)) openAsk(s.ask, false);
  if (!s.ask && d.open) d.close();
}

function openAsk(q: QueueItem, fromUser: boolean): void {
  if (fromUser) askDismissed.delete(q.id);
  const d = $<HTMLDialogElement>('ask-dialog');
  d.dataset.id = q.id;
  d.dataset.title = q.title;
  $('ask-title').textContent = t('recorder.ask.title', { title: q.title });
  $('ask-error').hidden = true;
  openDialog(d, $('ask-keep'));
}

// ---------- actions ----------

async function record(): Promise<void> {
  if (!snap) return;
  if (snap.recording) {
    await invoke('stop_recording').catch(showError);
    titleTouched = false;
    return;
  }
  const p = snap.permissions;
  if (p.microphone === 'not_determined' || p.system_audio === 'not_determined') {
    pendingStart = true;
    render(snap);
    $('permissions').querySelector<HTMLElement>('button')?.focus();
    return;
  }
  await start();
}

async function start(): Promise<void> {
  const title = $<HTMLInputElement>('title').value.trim() || defaultTitle();
  try {
    await invoke('start_recording', { title });
    $('record').focus();
  } catch (e) {
    showError(e);
  }
}

async function askPermissions(): Promise<void> {
  const result = await invoke<{ microphone: string; system_audio: string }>('request_permissions');
  pendingStart = false;
  if (result.microphone === 'granted' || result.system_audio === 'granted') await start();
  else if (snap) render(snap);
}

function showError(e: unknown): void {
  const key = typeof e === 'string' && e.includes('.') ? e : 'recorder.error.file';
  // Shown as the window's notice; Rust holds no error for a refused command.
  const box = $('banners');
  const b = el('div', { className: 'banner warn' }, icon('warning'), el('span', { className: 'banner-text', textContent: t(key) }));
  b.setAttribute('role', 'alert');
  box.prepend(b);
}

async function connectAgain(): Promise<void> {
  await invoke('start_connect').catch(() => undefined);
}

function openDisconnect(): void {
  if (!snap?.connection) return;
  const pending = snap.queue.filter((q) => ['uploading', 'pending', 'warn', 'ask_user'].includes(q.status)).length;
  $('disconnect-title').textContent = t('recorder.disconnect.title', { product: product() });
  $('disconnect-body').textContent = t('recorder.disconnect.body', { host: snap.host_label ?? '' });
  const pend = $('disconnect-pending');
  pend.textContent = pending ? t('recorder.disconnect.pending', { count: pending }) : '';
  pend.hidden = !pending;
  $('disconnect-error').hidden = true;
  $('disconnect-local').hidden = true;
  openDialog($<HTMLDialogElement>('disconnect-dialog'), $('disconnect-cancel'));
}

async function disconnect(localOnly: boolean): Promise<void> {
  try {
    await invoke('disconnect', { localOnly });
    $<HTMLDialogElement>('disconnect-dialog').close();
  } catch (e) {
    const err = $('disconnect-error');
    err.textContent = t(String(e), { host: snap?.host_label ?? '' });
    err.hidden = false;
    $('disconnect-local').hidden = false;
  }
}

function pickModel(id: string): void {
  const m = snap?.live.models.find((x) => x.id === id);
  if (!m) return;
  if (m.downloaded) {
    invoke('set_model', { id });
    return;
  }
  if (m.download && !m.download.failed) {
    invoke('set_model', { id });
    return;
  }
  modelAsked = id;
  $('model-title').textContent = t('recorder.model.sizeTitle', { model: m.label });
  $('model-body').textContent = t('recorder.model.size', { model: m.label, size: size(m.size) });
  openDialog($<HTMLDialogElement>('model-dialog'), $('model-cancel'));
}

// ---------- wiring ----------

function wire(): void {
  $('host-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('host');
    const err = $('host-error');
    try {
      await invoke('set_host', { input: input.value });
      input.removeAttribute('aria-invalid');
      err.hidden = true;
      await invoke('start_connect');
    } catch (key) {
      input.setAttribute('aria-invalid', 'true');
      err.textContent = t(String(key));
      err.hidden = false;
      input.focus();
    }
  });
  $('reopen').addEventListener('click', () => invoke('reopen_connect'));
  $('cancel-connect').addEventListener('click', () => invoke('cancel_connect'));
  $('record').addEventListener('click', record);
  $('title').addEventListener('input', () => (titleTouched = true));
  $('live-toggle').addEventListener('click', () => {
    if (!snap) return;
    const on = !snap.live.enabled;
    invoke('set_live', { enabled: on });
    const m = snap.live.models.find((x) => x.id === snap!.live.model);
    if (on && m && !m.downloaded && !m.download) pickModel(m.id);
  });
  $('show-live').addEventListener('click', () => invoke('show_live'));
  $('model').addEventListener('change', (e) => pickModel((e.target as HTMLSelectElement).value));
  $('model-confirm').addEventListener('click', () => {
    if (modelAsked) {
      invoke('download_model', { id: modelAsked });
      invoke('set_model', { id: modelAsked });
    }
    $<HTMLDialogElement>('model-dialog').close();
  });
  $('model-cancel').addEventListener('click', () => $<HTMLDialogElement>('model-dialog').close());
  $('model-dialog').addEventListener('close', () => {
    modelAsked = null;
    if (snap) renderFooter(snap);
  });
  $('ask-keep').addEventListener('click', () => {
    const id = $('ask-dialog').dataset.id!;
    invoke('keep_trying', { id });
    $<HTMLDialogElement>('ask-dialog').close();
  });
  $('ask-save').addEventListener('click', async () => {
    const d = $('ask-dialog');
    try {
      const saved = await invoke<boolean>('save_elsewhere', { id: d.dataset.id, title: d.dataset.title, dialogTitle: t('recorder.ask.saveTitle') });
      if (saved) $<HTMLDialogElement>('ask-dialog').close();
    } catch (e) {
      const err = $('ask-error');
      err.textContent = t(String(e));
      err.hidden = false;
    }
  });
  // Escape or close without a choice: the question waits in the list row.
  $('ask-dialog').addEventListener('close', () => {
    const id = $('ask-dialog').dataset.id;
    if (id) askDismissed.add(id);
  });
  $('disconnect-confirm').addEventListener('click', () => disconnect(false));
  $('disconnect-local').addEventListener('click', () => disconnect(true));
  $('disconnect-cancel').addEventListener('click', () => $<HTMLDialogElement>('disconnect-dialog').close());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => snap && render(snap));
}

async function main(): Promise<void> {
  wire();
  render(await invoke<Snapshot>('snapshot'));
  await listen<Snapshot>('snapshot', (e) => render(e.payload));
  await listen<{ mic: number; system: number; elapsed_s: number }>('levels', (e) => {
    ($('mic-level') as HTMLMeterElement).value = e.payload.mic;
    ($('sys-level') as HTMLMeterElement).value = e.payload.system;
    $('clock').textContent = clock(e.payload.elapsed_s);
  });
  await listen('confirm-disconnect', openDisconnect);
  // Permissions may change in System Settings while the window is away.
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) invoke('refresh');
  });
}

main();
