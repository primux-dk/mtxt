'use client';

import { useTranslations } from 'next-intl';
import type { SttProvider } from '@mtxt/adapters/db/schema';

/**
 * The data-flow panel: where audio goes for the provider picked on the page,
 * which model writes the recap and by which route, and the retention typed
 * there, as this build does it: AssemblyAI is called directly (AI Gateway
 * does not front it), Workers AI and the recap model go through AI Gateway
 * when an id is typed. It does not promise EU-only processing.
 */
export function DataFlow({
  provider,
  providerName,
  audioDays,
  textDays,
  supported,
  available,
  recapName,
  gateway,
}: {
  provider: SttProvider | null;
  providerName: string;
  /** The recap model's provider, by name. */
  recapName: string;
  /** An AI Gateway id is typed: ElevenLabs, Workers AI and the recap model go through it. */
  gateway: boolean;
  audioDays: number;
  textDays: number;
  /** The providers this build transcribes with, by name. */
  supported: string[];
  /** The provider picked on the page is one this build transcribes with. */
  available: boolean;
}) {
  const t = useTranslations('settings.dataflow');
  const ts = useTranslations('stt');
  const list = new Intl.ListFormat(useTranslations('locale')('intl'), {
    type: 'conjunction',
  }).format(supported);
  const step2 = !provider
    ? t('step2None')
    : !available
      ? t('step2Unavailable', { provider: providerName })
      : provider === 'workers-ai-whisper'
        ? t(gateway ? 'step2WorkersAi' : 'step2WorkersAiDirect', { provider: providerName })
        : provider === 'elevenlabs'
          ? t(gateway ? 'step2ElevenLabs' : 'step2ElevenLabsDirect', { provider: providerName })
          : t('step2', { provider: providerName });
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
          {gateway
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
