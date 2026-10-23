'use client';

import { useTranslations } from 'next-intl';
import type { SttProvider } from '@mtxt/adapters/db/schema';

/** How the chosen provider gets the audio: AssemblyAI and Azure Speech directly; AI Gateway fronts the rest it supports. */
const ROUTE: Record<SttProvider, 'direct' | 'gateway' | 'local'> = {
  assemblyai: 'direct',
  azure: 'direct',
  elevenlabs: 'gateway',
  'workers-ai-whisper': 'gateway',
  'local-whisper': 'local',
  'local-parakeet': 'local',
};

/**
 * The data-flow panel: where audio goes for the provider picked on the page,
 * which model writes the recap and by which route, and the retention typed
 * there. It does not promise EU-only processing.
 */
export function DataFlow({
  provider,
  providerName,
  audioDays,
  textDays,
  supported,
  recapName,
  recapGateway,
}: {
  provider: SttProvider | null;
  providerName: string;
  /** The recap model's provider, by name, and whether its requests go through AI Gateway. */
  recapName: string;
  recapGateway: boolean;
  audioDays: number;
  textDays: number;
  /** The providers this build transcribes with, by name. */
  supported: string[];
}) {
  const t = useTranslations('settings.dataflow');
  const ts = useTranslations('stt');
  const list = new Intl.ListFormat(useTranslations('locale')('intl'), {
    type: 'conjunction',
  }).format(supported);
  const step2 = !provider
    ? t('step2None')
    : ROUTE[provider] === 'direct'
      ? t('step2', { provider: providerName })
      : ROUTE[provider] === 'gateway'
        ? t('step2Gateway', { provider: providerName })
        : t('step2Local', { provider: providerName });
  return (
    <aside
      aria-labelledby="dataflow-heading"
      className="mt-2 rounded-panel border border-accent-line-strong bg-accent-tint-soft p-6 text-sm max-shell:p-5"
    >
      <h2 id="dataflow-heading" className="mb-4 text-xl leading-[1.3]">
        {t('heading')}
      </h2>
      <ol className="grid list-decimal gap-2 pl-5">
        <li>{t('step1')}</li>
        <li>{step2}</li>
        <li>
          {recapGateway
            ? t('step3', { provider: recapName })
            : t('step3Direct', { provider: recapName })}
        </li>
        <li>{t('step4', { audioDays, textDays })}</li>
      </ol>
      <p className="mt-4">
        <strong className="font-[650]">{t('promise')}</strong> {t('caveats')}
      </p>
      <p className="mt-4">{ts('supported', { providers: list })}</p>
      <p className="mt-4">{t('local')}</p>
    </aside>
  );
}
