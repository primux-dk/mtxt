// The live window: the last finished line, muted, and the utterance in
// progress. Pause stops the text, not the recording; Hide hides the window.
// When the session ends, the text is dropped from the page and from memory.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { EMPTY, view, type LiveText } from './liveText';
import { setLanguage, t, translate } from './locale';
import { applyTheme } from './theme';
import type { LiveUpdate, Snapshot } from './types';

const $ = (id: string) => document.getElementById(id)!;
let shown: LiveText = EMPTY;

function renderSnapshot(s: Snapshot): void {
  setLanguage(s.language);
  translate();
  applyTheme(s.connection?.theme_accent, s.connection?.theme_primary);
  $('product').textContent = s.connection?.product_name ?? '';
  // No session: nothing of the last one stays on the page.
  if (!s.live.running) shown = EMPTY;
  render();
}

function render(): void {
  const b = $('pause');
  const key = shown.paused ? 'live.resume' : 'live.pause';
  b.setAttribute('aria-label', t(key));
  b.title = t(key);
  b.setAttribute('aria-pressed', String(shown.paused));
  b.querySelector('use')!.setAttribute('href', shown.paused ? '#i-play' : '#i-pause');
  const current = $('current');
  $('prev').textContent = shown.prev;
  current.textContent = shown.status ? t(shown.status) : shown.current;
  current.classList.toggle('status', !!shown.status);
}

async function main(): Promise<void> {
  // The new state comes back as a live update within 100 ms.
  $('pause').addEventListener('click', () => invoke('pause_live', { paused: !shown.paused }));
  $('hide').addEventListener('click', () => invoke('hide_live'));
  renderSnapshot(await invoke<Snapshot>('snapshot'));
  shown = view(await invoke<LiveUpdate | null>('live_state'));
  render();
  await listen<Snapshot>('snapshot', (e) => renderSnapshot(e.payload));
  await listen<LiveUpdate>('live', (e) => {
    shown = view(e.payload);
    render();
  });
}

main();
