import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { listKeyterms, listTemplates } from '@mtxt/adapters';
import { SettingsForm, type SettingsFormProps } from '@/components/settings/settings-form';
import { requireAdmin } from '@/lib/auth/session';
import { PROVIDER_IDS } from '@/lib/auth/provider';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { formatKeyterms } from '@/lib/settings/keyterms';
import { TRANSCRIPTION_LANGUAGES } from '@/lib/settings/validate';
import { endpointRows } from '@/lib/webhooks/rows';

/**
 * Figure 07: the whole admin surface, every row of the spec's settings table
 * and nothing else. Admins only; anyone else gets the 403 page.
 */
export default async function SettingsPage() {
  await requireAdmin('/settings');
  const [settings, { db, installId }, locale, t, h] = await Promise.all([
    getInstallSettings(),
    getAdapters(),
    getLocale(),
    getTranslations('settings'),
    headers(),
  ]);
  const [terms, templates, endpoints] = await Promise.all([
    listKeyterms(db, installId),
    listTemplates(db, installId),
    endpointRows(),
  ]);

  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  const callback = (id: string) => `${proto}://${host}/api/auth/callback/${id}`;

  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const languages = TRANSCRIPTION_LANGUAGES.map((code) => ({
    code,
    name: code === 'auto' ? t('stt.autoDetect') : (names.of(code) ?? code),
  }));

  const props: SettingsFormProps = {
    values: {
      productName: settings.productName,
      companyName: settings.companyName ?? '',
      themeAccent: settings.themeAccent,
      themePrimary: settings.themePrimary,
      identityProvider: settings.identityProvider,
      oidcTenantId: settings.oidcTenantId ?? '',
      oidcClientId: settings.oidcClientId ?? '',
      sttProvider: settings.sttProvider,
      sttRegion: settings.sttRegion ?? '',
      aiGatewayId: settings.aiGatewayId ?? '',
      language: settings.language,
      recapProvider: settings.recapProvider,
      recapModel: settings.recapModel ?? '',
      interfaceLanguage: settings.interfaceLanguage,
      keyterms: formatKeyterms(terms),
      liveTranscriptDefault: settings.liveTranscriptDefault,
      defaultVisibility: settings.defaultVisibility,
      recordingSources: [...settings.recordingSources],
      retentionAudioDays: settings.retentionAudioDays,
      retentionTranscriptDays: settings.retentionTranscriptDays,
      mcpEnabled: settings.mcpEnabled,
      webhookAutoSend: settings.webhookAutoSend,
      adminEmails: settings.adminEmails.join('\n'),
    },
    // Whether a secret is stored, never the secret.
    hasClientSecret: Boolean(settings.oidcClientSecret),
    hasSttKey: Boolean(settings.sttApiKey),
    hasRecapKey: Boolean(settings.recapApiKey),
    redirectUris: { entra: callback(PROVIDER_IDS.entra), google: callback(PROVIDER_IDS.google) },
    languages,
    templates: templates.map(({ id, name, bodyMd, isDefault }) => ({
      id,
      name,
      bodyMd,
      isDefault,
    })),
    endpoints,
  };

  return <SettingsForm {...props} />;
}
