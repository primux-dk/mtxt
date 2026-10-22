'use client';

import { useEffect } from 'react';
import { recorderSession } from '@/lib/recorder-session';

/**
 * Mounted once in the app layout: while the browser recorder holds audio
 * the server has not confirmed, leaving or reloading any page of the app
 * asks first. It holds after an in-app Leave too, on every page, until the
 * audio is confirmed or discarded on the New meeting page.
 */
export function UnconfirmedAudioGuard() {
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (recorderSession.hasUnconfirmedAudio()) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  return null;
}
