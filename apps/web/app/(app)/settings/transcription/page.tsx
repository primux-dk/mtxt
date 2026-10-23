import { getLocale, getTranslations } from 'next-intl/server';
import { listKeyterms } from '@mtxt/adapters';
import { TranscriptionForm } from '@/components/settings/transcription-form';
import { requireAdmin } from '@/lib/auth/session';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { formatKeyterms } from '@/lib/settings/keyterms';
import { TRANSCRIPTION_LANGUAGES } from '@/lib/settings/validate';

/** Figure 07b, the Transcription tab. Admins only. */
export default async function TranscriptionPage() {
  await requireAdmin('/settings/transcription');
  const [settings, { db, installId }, locale, t] = await Promise.all([
    getInstallSettings(),
    getAdapters(),
    getLocale(),
    getTranslations('settings'),
  ]);
  const terms = await listKeyterms(db, installId);
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const languages = TRANSCRIPTION_LANGUAGES.map((code) => ({
    code,
    name: code === 'auto' ? t('stt.autoDetect') : (names.of(code) ?? code),
  }));
  return (
    <TranscriptionForm
      values={{
        sttProvider: settings.sttProvider,
        sttRegion: settings.sttRegion ?? '',
        aiGatewayId: settings.aiGatewayId ?? '',
        language: settings.language,
        keyterms: formatKeyterms(terms),
        liveTranscriptDefault: settings.liveTranscriptDefault,
      }}
      hasSttKey={Boolean(settings.sttApiKey)}
      languages={languages}
      recapProvider={settings.recapProvider}
      retention={{
        audioDays: settings.retentionAudioDays,
        textDays: settings.retentionTranscriptDays,
      }}
    />
  );
}
