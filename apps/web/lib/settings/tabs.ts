import type { Field } from './validate';

/*
  The settings page's tabs, one route each under /settings (docs/spec.md
  "Settings page"). The first five are forms; each saves only its own fields.
  Webhooks and the audit log have no fields of their own.
*/
export const SETTINGS_TABS = [
  'general',
  'login',
  'transcription',
  'recap',
  'sharing',
  'webhooks',
  'audit',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const FORM_TABS = ['general', 'login', 'transcription', 'recap', 'sharing'] as const;
export type FormTab = (typeof FORM_TABS)[number];

/** Each form tab's fields, in the order they appear on it. */
export const TAB_FIELDS = {
  general: [
    'productName',
    'companyName',
    'themeAccent',
    'themePrimary',
    'interfaceLanguage',
    'timeZone',
  ],
  login: ['identityProvider', 'oidcTenantId', 'oidcClientId', 'oidcClientSecret', 'adminEmails'],
  transcription: ['sttProvider', 'sttApiKey', 'sttRegion', 'aiGatewayId', 'language', 'keyterms'],
  recap: ['recapProvider', 'recapModel', 'recapApiKey'],
  sharing: [
    'defaultVisibility',
    'recordingSources',
    'retentionAudioDays',
    'retentionTranscriptDays',
    'webhookAutoSend',
  ],
} as const satisfies Record<FormTab, readonly Field[]>;

export const isFormTab = (value: unknown): value is FormTab =>
  (FORM_TABS as readonly unknown[]).includes(value);

export const tabHref = (tab: SettingsTab) => `/settings/${tab}`;

/** The tab a settings path belongs to: `/settings/webhooks/{id}` is the Webhooks tab. */
export function tabOf(pathname: string): SettingsTab | null {
  const segment = pathname.split('/')[2];
  return (SETTINGS_TABS as readonly string[]).includes(segment ?? '')
    ? (segment as SettingsTab)
    : null;
}
