// The live window: every finished line of the running recording, newest at
// the bottom, with where it starts; the line in progress muted under them.
// It follows new lines while the view is at the bottom and stops following
// when the user scrolls up ("Jump to latest" then). Arrows and Page keys
// scroll, End jumps to the latest. Pause stops the text, not the recording;
// Hide hides the window. When the session ends, the text is dropped from the
// page and from memory.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { duration } from './format';
import { accept, atBottom, EMPTY, reconcile, statusKey } from './liveText';
import { setLanguage, t, translate } from './locale';
import { applyTheme } from './theme';
import type { LiveLine, LiveTranscript, LiveUpdate, Snapshot } from './types';

const $ = (id: string) => document.getElementById(id)!;
let shown: LiveTranscript = EMPTY;
let follow = true;
let rendered = 0;

function lineNode(l: LiveLine): HTMLLIElement {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.className = 'live-time';
  time.textContent = duration(l.at_s);
  time.dateTime = `PT${Math.floor(l.at_s)}S`;
  const text = document.createElement('span');
  text.textContent = l.text;
  li.append(time, text);
  return li;
}

function renderSnapshot(s: Snapshot): void {
  setLanguage(s.language, s.platform);
  translate();
  applyTheme(s.connection?.theme_accent, s.connection?.theme_primary);
  $('product').textContent = s.connection?.product_name ?? '';
  // No session: nothing of the last one stays on the page.
  if (!s.live.running) set(EMPTY);
  else render();
}

function set(next: LiveTranscript): void {
  const reset =
    next.session !== shown.session ||
    next.lines.length < rendered ||
    (next.lines.length === 0 && rendered > 0);
  shown = next;
  if (reset) {
    $('lines').replaceChildren();
    rendered = 0;
    follow = true;
  }
  render();
}

function render(): void {
  const copy = $('copy');
  const list = $('lines');
  for (; rendered < shown.lines.length; rendered++) list.append(lineNode(shown.lines[rendered]!));
  const partial = $('partial');
  partial.hidden = !shown.partial;
  partial.textContent = shown.partial?.text ?? '';
  const key = statusKey(shown);
  const status = $('status');
  status.hidden = !key;
  status.textContent = key ? t(key, { reason: shown.reason ?? '' }) : '';
  const paused = shown.state === 'paused';
  const b = $('pause');
  const label = paused ? 'live.resume' : 'live.pause';
  b.setAttribute('aria-label', t(label));
  b.title = t(label);
  b.setAttribute('aria-pressed', String(paused));
  b.querySelector('use')!.setAttribute('href', paused ? '#i-play' : '#i-pause');
  // Follow while the reader is at the end; a reader who scrolled up stays put.
  if (follow) copy.scrollTop = copy.scrollHeight;
  $('jump').hidden = follow;
}

function jumpToLatest(): void {
  follow = true;
  const copy = $('copy');
  copy.scrollTop = copy.scrollHeight;
  $('jump').hidden = true;
}

async function main(): Promise<void> {
  const copy = $('copy');
  // Scrolling up stops following; reaching the end again resumes it.
  copy.addEventListener('scroll', () => {
    follow = atBottom(copy);
    $('jump').hidden = follow;
  });
  copy.addEventListener('keydown', (e) => {
    if (e.key === 'End') {
      e.preventDefault();
      jumpToLatest();
    }
  });
  $('jump').addEventListener('click', () => {
    jumpToLatest();
    copy.focus();
  });
  // The new state comes back as a live update within 100 ms.
  $('pause').addEventListener('click', () =>
    invoke('pause_live', { paused: shown.state !== 'paused' }),
  );
  $('hide').addEventListener('click', () => invoke('hide_live'));
  // Listen first, keep what arrives, then fetch the state and reconcile:
  // a line or a Stop sent while the state was on its way is never lost.
  let buffered: LiveUpdate[] | null = [];
  await listen<LiveUpdate>('live', (e) => {
    if (buffered) buffered.push(e.payload);
    else set(accept(shown, e.payload));
  });
  await listen<Snapshot>('snapshot', (e) => renderSnapshot(e.payload));
  const state = await invoke<LiveTranscript>('live_state');
  set(reconcile(state, buffered));
  buffered = null;
  renderSnapshot(await invoke<Snapshot>('snapshot'));
}

main();
