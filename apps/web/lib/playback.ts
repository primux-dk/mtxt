'use client';

import { useSyncExternalStore } from 'react';

/*
  The meeting page's one player, shared with the transcript: the player
  registers its <audio>, the transcript reads the time and seeks. A module
  store rather than a context, because the player and the transcript are
  separate client islands on a server page.
*/
let audio: HTMLAudioElement | null = null;
let time = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function registerAudio(el: HTMLAudioElement | null) {
  audio = el;
  time = el?.currentTime ?? 0;
  emit();
}

/** Called by the player on every time update. */
export function reportTime(seconds: number) {
  if (Math.floor(seconds * 4) === Math.floor(time * 4)) return;
  time = seconds;
  emit();
}

/** Seeks the player; returns false when there is no playable audio. */
export function seekTo(seconds: number): boolean {
  if (!audio || audio.error) return false;
  audio.currentTime = seconds;
  time = seconds;
  emit();
  return true;
}

export const hasAudio = () => Boolean(audio && !audio.error);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The playhead in seconds, a few times a second while playing. */
export function usePlayhead(): number {
  return useSyncExternalStore(
    subscribe,
    () => time,
    () => 0,
  );
}
