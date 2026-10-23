// The live window: the last finished line, muted, and the utterance in
// progress. Pause stops the text, not the recording; Hide hides the window.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setLanguage, t, translate } from './locale';
import { applyTheme } from './theme';
import type { LiveUpdate, Snapshot } from './types';

const $ = (id: string) => document.getElementById(id)!;
let paused = false;
let last: LiveUpdate | null = null;

function renderSnapshot(s: Snapshot): void {
  setLanguage(s.language);
  translate();
  applyTheme(s.connection?.theme_accent, s.connection?.theme_primary);
  $('product').textContent = s.connection?.product_name ?? '';
  renderPause();
  if (last) renderText(last);
}

function renderPause(): void {
  const b = $('pause');
  const key = paused ? 'live.resume' : 'live.pause';
  b.setAttribute('aria-label', t(key));
  b.title = t(key);
  b.setAttribute('aria-pressed', String(paused));
  b.querySelector('use')!.setAttribute('href', paused ? '#i-play' : '#i-pause');
}

function renderText(u: LiveUpdate): void {
  last = u;
  paused = u.state === 'paused';
  renderPause();
  const prev = $('prev');
  const current = $('current');
  current.classList.remove('status');
  const status = (key: string) => {
    prev.textContent = '';
    current.textContent = t(key);
    current.classList.add('status');
  };
  switch (u.state) {
    case 'loading':
      return status('live.loading');
    case 'needs_model':
      return status('live.needsModel');
    case 'error':
      return status('live.error');
    case 'paused':
      return status('live.paused');
  }
  const lines = [...u.lines];
  if (u.partial) lines.push(u.partial);
  if (lines.length === 0) return status('live.listening');
  current.textContent = lines.pop() ?? '';
  prev.textContent = lines.pop() ?? '';
}

async function main(): Promise<void> {
  // The new state comes back as a live update within 100 ms.
  $('pause').addEventListener('click', () => invoke('pause_live', { paused: !paused }));
  $('hide').addEventListener('click', () => invoke('hide_live'));
  renderSnapshot(await invoke<Snapshot>('snapshot'));
  const state = await invoke<LiveUpdate | null>('live_state');
  if (state) renderText(state);
  await listen<Snapshot>('snapshot', (e) => renderSnapshot(e.payload));
  await listen<LiveUpdate>('live', (e) => renderText(e.payload));
}

main();
