// A stand-in for Tauri's IPC, so the real pages render in a browser from a
// fixture: `?state=figure05&lang=da&theme=dark`. For screenshots and design
// review only; the app never loads this.

import { live, snapshot } from './fixtures';

const params = new URLSearchParams(location.search);
const state = params.get('state') ?? 'figure05';
const lang = params.get('lang') ?? 'en';
const liveState = params.get('live') ?? 'listening';
const dark = params.get('theme') === 'dark';

// prefers-color-scheme follows the query in the preview.
const realMatch = window.matchMedia.bind(window);
window.matchMedia = (q: string) =>
  q.includes('prefers-color-scheme')
    ? ({
        matches: dark,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as MediaQueryList)
    : realMatch(q);

let next = 1;
const label = location.pathname.includes('live') ? 'live' : 'main';
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
  transformCallback: () => next++,
  unregisterCallback: () => undefined,
  invoke: async (cmd: string) => {
    switch (cmd) {
      case 'snapshot':
        return snapshot(state, lang);
      case 'live_state':
        return live[liveState] ?? null;
      default:
        return null;
    }
  },
};
(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => undefined,
};
