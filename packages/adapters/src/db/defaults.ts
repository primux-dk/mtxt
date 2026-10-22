/**
 * The settings row a new install starts with. Kept free of imports so the seed
 * script can load it with Node's own TypeScript support.
 */
export const DEFAULT_SETTINGS = {
  productName: 'mtxt install',
  companyName: null,
  themeAccent: '#566b45',
  themePrimary: '#111111',
  identityProvider: null,
  oidcTenantId: null,
  oidcClientId: null,
  oidcClientSecret: null,
  sttProvider: null,
  sttApiKey: null,
  sttRegion: null,
  language: 'auto',
  interfaceLanguage: 'en',
  liveTranscriptDefault: false,
  defaultVisibility: 'private',
  retentionAudioDays: 30,
  retentionTranscriptDays: 365,
  mcpEnabled: false,
  recordingSources: ['desktop', 'upload', 'browser'],
  adminEmails: [],
} as const;
