'use client';

import { useTranslations } from 'next-intl';
import type { RecapProvider, SttProvider } from '@mtxt/adapters/db/schema';

/** The speech-to-text and recap providers by name, for the selects and the data-flow panel. */
export function useProviderNames() {
  const t = useTranslations('settings');
  const stt = (p: SttProvider) =>
    p === 'local-whisper'
      ? t('stt.local', { model: 'Whisper' })
      : p === 'local-parakeet'
        ? t('stt.local', { model: 'Parakeet' })
        : t(`stt.providers.${p === 'workers-ai-whisper' ? 'workersAi' : p}`);
  const recap = (p: RecapProvider) =>
    t(
      `recap.providers.${p === 'workers-ai' ? 'workersAi' : p === 'azure-openai' ? 'azureOpenai' : p}`,
    );
  return { stt, recap };
}
