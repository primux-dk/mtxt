/*
  Validation for the settings page. Pure: it takes the submitted form and the
  current row, and returns either the columns to write or one error per field.
  Errors are codes with values; the server action turns them into strings in
  the reader's language. The server never trusts the browser's own checks.
*/
import {
  CAPTURE_SOURCES,
  IDENTITY_PROVIDERS,
  INTERFACE_LANGUAGES,
  STT_PROVIDERS,
  VISIBILITIES,
  type CaptureSource,
  type Settings,
  type SttProvider,
  templateNameKey,
} from '@mtxt/adapters';
import { isTenantGuid } from '../auth/identity';
import { HEX, themeFailures, type ContrastPair, type ThemeMode } from '../theme/contrast';
import { parseKeyterms, type Keyterm, type KeytermError } from './keyterms';

export const MAX_NAME = 120;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_TEMPLATE_NAME = 80;
export const MAX_TEMPLATE_BODY = 20_000;
export const TRANSCRIPTION_LANGUAGES = [
  'auto',
  'da',
  'en',
  'sv',
  'nb',
  'de',
  'nl',
  'fr',
  'es',
  'fi',
] as const;
/** Providers that need an API key. Workers AI uses the Worker's own binding; local models run on the install. */
export const STT_NEEDS_KEY: readonly SttProvider[] = ['assemblyai', 'azure', 'elevenlabs'];
export const ELEVENLABS_REGIONS = ['', 'eu'] as const;
/** The providers this build transcribes with (lib/stt AVAILABLE_PROVIDERS); the rest are refused at save. */
export const STT_AVAILABLE: readonly SttProvider[] = ['assemblyai', 'workers-ai-whisper'];
/** A Cloudflare AI Gateway id: letters, digits, - and _. */
const GATEWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The order fields appear on the page, so the error summary lists them top to bottom. */
export const FIELDS = [
  'productName',
  'companyName',
  'themeAccent',
  'themePrimary',
  'identityProvider',
  'oidcTenantId',
  'oidcClientId',
  'oidcClientSecret',
  'sttProvider',
  'sttApiKey',
  'sttRegion',
  'aiGatewayId',
  'language',
  'interfaceLanguage',
  'keyterms',
  'defaultVisibility',
  'recordingSources',
  'retentionAudioDays',
  'retentionTranscriptDays',
  'adminEmails',
] as const;
export type Field = (typeof FIELDS)[number];

export type FieldError =
  | { code: 'required' }
  | { code: 'tooLong'; max: number }
  | { code: 'invalid' }
  | { code: 'hex'; value: string }
  | { code: 'contrast'; ratio: number; pair: ContrastPair; mode: ThemeMode }
  | { code: 'tenantFormat' }
  | { code: 'domainFormat' }
  | { code: 'secretRequired' }
  | { code: 'regionFormat' }
  | { code: 'notAvailable' }
  | { code: 'gatewayFormat' }
  | KeytermError
  | { code: 'atLeastOneSource' }
  | { code: 'range'; min: number; max: number }
  | { code: 'email'; value: string }
  | { code: 'atLeastOneAdmin' }
  | { code: 'keepSelf'; email: string };

export type Errors = Partial<Record<Field, FieldError>>;

export interface SettingsPatch {
  productName: string;
  companyName: string | null;
  themeAccent: string;
  themePrimary: string;
  identityProvider: Settings['identityProvider'];
  oidcTenantId: string;
  oidcClientId: string;
  sttProvider: SttProvider | null;
  sttRegion: string | null;
  aiGatewayId: string | null;
  language: string;
  interfaceLanguage: Settings['interfaceLanguage'];
  liveTranscriptDefault: boolean;
  defaultVisibility: Settings['defaultVisibility'];
  recordingSources: CaptureSource[];
  retentionAudioDays: number;
  retentionTranscriptDays: number;
  mcpEnabled: boolean;
  adminEmails: string[];
}

export type Validated =
  | {
      ok: true;
      patch: SettingsPatch;
      keyterms: Keyterm[];
      /** New plain-text secrets to seal; absent when the field was left blank. */
      secrets: { oidcClientSecret?: string; sttApiKey?: string };
      /** True when the STT provider no longer takes a key, so the stored one is cleared. */
      clearSttKey: boolean;
    }
  | { ok: false; errors: Errors };

/** What the validator needs to know about the stored row: never the secrets themselves. */
export interface Current {
  identityProvider: Settings['identityProvider'];
  hasClientSecret: boolean;
  sttProvider: SttProvider | null;
  hasSttKey: boolean;
}

// An Entra tenant is pinned by its GUID (not `common`, `organizations` or `consumers`);
// a Workspace domain is a domain.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// Deliberately plain: one @, no spaces, a dot in the domain. The IdP decides what is real.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AZURE_REGION = /^[a-z][a-z0-9]{1,30}$/;

const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

export function validateSettings(
  form: FormData,
  current: Current,
  signedInEmail: string,
): Validated {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const errors: Errors = {};

  const productName = text('productName');
  if (!productName) errors.productName = { code: 'required' };
  else if (productName.length > MAX_NAME) errors.productName = { code: 'tooLong', max: MAX_NAME };

  const companyName = text('companyName');
  if (companyName.length > MAX_NAME) errors.companyName = { code: 'tooLong', max: MAX_NAME };

  const themeAccent = text('themeAccent').toLowerCase();
  const themePrimary = text('themePrimary').toLowerCase();
  if (!HEX.test(themeAccent)) errors.themeAccent = { code: 'hex', value: themeAccent };
  if (!HEX.test(themePrimary)) errors.themePrimary = { code: 'hex', value: themePrimary };
  if (!errors.themeAccent && !errors.themePrimary) {
    for (const failure of themeFailures(themeAccent, themePrimary)) {
      const field = failure.input === 'accent' ? 'themeAccent' : 'themePrimary';
      // Worst pair first, so the first one per field is the one to show.
      errors[field] ??= {
        code: 'contrast',
        ratio: failure.ratio,
        pair: failure.pair,
        mode: failure.mode,
      };
    }
  }

  const identityProvider = text('identityProvider');
  const oidcTenantId = text('oidcTenantId');
  const oidcClientId = text('oidcClientId');
  const oidcClientSecret = text('oidcClientSecret');
  if (!oneOf(IDENTITY_PROVIDERS, identityProvider)) {
    errors.identityProvider = { code: 'required' };
  } else {
    if (!oidcTenantId) errors.oidcTenantId = { code: 'required' };
    else if (identityProvider === 'entra' && !isTenantGuid(oidcTenantId))
      errors.oidcTenantId = { code: 'tenantFormat' };
    else if (identityProvider === 'google' && !DOMAIN.test(oidcTenantId))
      errors.oidcTenantId = { code: 'domainFormat' };
    if (!oidcClientId) errors.oidcClientId = { code: 'required' };
    // A secret belongs to one provider's app registration; a new provider needs a new one.
    const keepsSecret = current.hasClientSecret && current.identityProvider === identityProvider;
    if (!oidcClientSecret && !keepsSecret) errors.oidcClientSecret = { code: 'secretRequired' };
  }

  const sttProviderText = text('sttProvider');
  const sttApiKey = text('sttApiKey');
  let sttProvider: SttProvider | null = null;
  let sttRegion: string | null = null;
  if (sttProviderText && !oneOf(STT_PROVIDERS, sttProviderText)) {
    errors.sttProvider = { code: 'invalid' };
  } else if (sttProviderText) {
    sttProvider = sttProviderText as SttProvider;
    // Still in the select, so an admin sees what is coming; not saved until this build has it.
    if (!STT_AVAILABLE.includes(sttProvider)) errors.sttProvider = { code: 'notAvailable' };
    const keepsKey = current.hasSttKey && current.sttProvider === sttProvider;
    if (STT_NEEDS_KEY.includes(sttProvider) && !sttApiKey && !keepsKey)
      errors.sttApiKey = { code: 'secretRequired' };
    const region = text('sttRegion').toLowerCase();
    if (sttProvider === 'azure') {
      if (!region) errors.sttRegion = { code: 'required' };
      else if (!AZURE_REGION.test(region)) errors.sttRegion = { code: 'regionFormat' };
      else sttRegion = region;
    } else if (sttProvider === 'elevenlabs') {
      if (!oneOf(ELEVENLABS_REGIONS, region)) errors.sttRegion = { code: 'invalid' };
      else sttRegion = region || null;
    }
  }

  const aiGatewayId = text('aiGatewayId');
  if (aiGatewayId && !GATEWAY_ID.test(aiGatewayId)) errors.aiGatewayId = { code: 'gatewayFormat' };

  const language = text('language');
  if (!oneOf(TRANSCRIPTION_LANGUAGES, language)) errors.language = { code: 'invalid' };
  const interfaceLanguage = text('interfaceLanguage');
  if (!oneOf(INTERFACE_LANGUAGES, interfaceLanguage))
    errors.interfaceLanguage = { code: 'invalid' };

  const parsed = parseKeyterms(String(form.get('keyterms') ?? ''));
  if (parsed.errors[0]) errors.keyterms = parsed.errors[0];

  const defaultVisibility = text('defaultVisibility');
  if (!oneOf(VISIBILITIES, defaultVisibility)) errors.defaultVisibility = { code: 'invalid' };

  const sources = form.getAll('recordingSources').map(String);
  const recordingSources = CAPTURE_SOURCES.filter((s) => sources.includes(s));
  if (recordingSources.length === 0) errors.recordingSources = { code: 'atLeastOneSource' };

  const days = (name: 'retentionAudioDays' | 'retentionTranscriptDays') => {
    const raw = text(name);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1 || value > MAX_RETENTION_DAYS) {
      errors[name] = { code: 'range', min: 1, max: MAX_RETENTION_DAYS };
    }
    return value;
  };
  const retentionAudioDays = days('retentionAudioDays');
  const retentionTranscriptDays = days('retentionTranscriptDays');

  const adminEmails: string[] = [];
  for (const line of String(form.get('adminEmails') ?? '').split(/[\n,;]+/)) {
    const email = line.trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL.test(email)) {
      errors.adminEmails ??= { code: 'email', value: email };
      continue;
    }
    if (!adminEmails.includes(email)) adminEmails.push(email);
  }
  if (!errors.adminEmails) {
    const self = signedInEmail.trim().toLowerCase();
    if (adminEmails.length === 0) errors.adminEmails = { code: 'atLeastOneAdmin' };
    else if (!adminEmails.includes(self)) errors.adminEmails = { code: 'keepSelf', email: self };
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    patch: {
      productName,
      companyName: companyName || null,
      themeAccent,
      themePrimary,
      identityProvider: identityProvider as Settings['identityProvider'],
      oidcTenantId,
      oidcClientId,
      sttProvider,
      sttRegion,
      aiGatewayId: aiGatewayId || null,
      language,
      interfaceLanguage: interfaceLanguage as Settings['interfaceLanguage'],
      liveTranscriptDefault: form.get('liveTranscriptDefault') === 'on',
      defaultVisibility: defaultVisibility as Settings['defaultVisibility'],
      recordingSources,
      retentionAudioDays,
      retentionTranscriptDays,
      mcpEnabled: form.get('mcpEnabled') === 'on',
      adminEmails,
    },
    keyterms: parsed.terms,
    secrets: {
      ...(oidcClientSecret ? { oidcClientSecret } : {}),
      ...(sttApiKey && sttProvider && STT_NEEDS_KEY.includes(sttProvider) ? { sttApiKey } : {}),
    },
    clearSttKey: !sttProvider || !STT_NEEDS_KEY.includes(sttProvider),
  };
}

export type TemplateField = 'name' | 'bodyMd';
export type TemplateError =
  { code: 'required' } | { code: 'tooLong'; max: number } | { code: 'duplicate'; name: string };

/** A template's name and body. `others` are the install's other templates. */
export function validateTemplate(
  value: { name: string; bodyMd: string },
  others: readonly { name: string }[],
):
  | { ok: true; name: string; bodyMd: string }
  | { ok: false; errors: Partial<Record<TemplateField, TemplateError>> } {
  const name = value.name.trim();
  const bodyMd = value.bodyMd.replace(/\r\n/g, '\n');
  const errors: Partial<Record<TemplateField, TemplateError>> = {};
  if (!name) errors.name = { code: 'required' };
  else if (name.length > MAX_TEMPLATE_NAME)
    errors.name = { code: 'tooLong', max: MAX_TEMPLATE_NAME };
  else if (others.some((t) => templateNameKey(t.name) === templateNameKey(name)))
    errors.name = { code: 'duplicate', name };
  if (bodyMd.length > MAX_TEMPLATE_BODY)
    errors.bodyMd = { code: 'tooLong', max: MAX_TEMPLATE_BODY };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, name, bodyMd };
}
