/*
  Validation for the settings page. Pure: it takes the submitted form and the
  current row, and returns either the columns to write or one error per field.
  Errors are codes with values; the server action turns them into strings in
  the reader's language. The server never trusts the browser's own checks.
*/
import {
  RECAP_PROVIDERS,
  type RecapProvider,
  CAPTURE_SOURCES,
  IDENTITY_PROVIDERS,
  INTERFACE_LANGUAGES,
  STT_PROVIDERS,
  VISIBILITIES,
  WEBHOOK_AUTO_SEND,
  WEBHOOK_EVENTS,
  type CaptureSource,
  type WebhookAutoSend,
  type WebhookEvent,
  type Settings,
  type SttProvider,
  templateNameKey,
} from '@mtxt/adapters';
import { isTenantGuid } from '../auth/identity';
import { HEX, themeFailures, type ContrastPair, type ThemeMode } from '../theme/contrast';
import { parseKeyterms, type Keyterm, type KeytermError } from './keyterms';
import { validTimeZone } from '../recap/due';
import { AZURE_MODEL, MODEL_ID, NEEDS_RECAP_KEY } from '../recap/models';
import { checkEndpointUrl } from '../webhooks/address';
import { MAX_LABEL_LENGTH, MAX_URL_LENGTH } from '../webhooks/rules';
import { FORM_TABS, type FormTab } from './tabs';

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
/** The providers this build transcribes with (lib/stt AVAILABLE_PROVIDERS); the rest are refused at save. */
export const STT_AVAILABLE: readonly SttProvider[] = [
  'assemblyai',
  'elevenlabs',
  'workers-ai-whisper',
];
/** A Cloudflare AI Gateway id: letters, digits, - and _. */
const GATEWAY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The order fields appear on the page, so the error summary lists them top to bottom (lib/settings/tabs.ts groups them by tab). */
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
  'recapProvider',
  'recapModel',
  'recapApiKey',
  'interfaceLanguage',
  'timeZone',
  'keyterms',
  'defaultVisibility',
  'recordingSources',
  'retentionAudioDays',
  'retentionTranscriptDays',
  'webhookAutoSend',
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
  | { code: 'modelFormat' }
  | { code: 'azureModel' }
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
  recapProvider: RecapProvider;
  /** Null means the provider's default model. */
  recapModel: string | null;
  interfaceLanguage: Settings['interfaceLanguage'];
  timeZone: string;
  liveTranscriptDefault: boolean;
  defaultVisibility: Settings['defaultVisibility'];
  recordingSources: CaptureSource[];
  retentionAudioDays: number;
  retentionTranscriptDays: number;
  mcpEnabled: boolean;
  webhookAutoSend: WebhookAutoSend;
  adminEmails: string[];
}

export type Validated =
  | {
      ok: true;
      /** Only the columns of the tabs that were validated. */
      patch: Partial<SettingsPatch>;
      /** The new list, when the Transcription tab was validated; otherwise the list stays. */
      keyterms?: Keyterm[];
      /** New plain-text secrets to seal; absent when the field was left blank. */
      secrets: { oidcClientSecret?: string; sttApiKey?: string; recapApiKey?: string };
      /** True when the Transcription tab's provider takes no key, so the stored one is cleared. */
      clearSttKey: boolean;
      /** True when the Recap tab's provider changed or takes no key: the stored key belonged to another one. */
      clearRecapKey: boolean;
    }
  | { ok: false; errors: Errors };

/** What the validator needs to know about the stored row: never the secrets themselves. */
export interface Current {
  identityProvider: Settings['identityProvider'];
  hasClientSecret: boolean;
  sttProvider: SttProvider | null;
  hasSttKey: boolean;
  recapProvider: RecapProvider;
  hasRecapKey: boolean;
}

// An Entra tenant is pinned by its GUID (not `common`, `organizations` or `consumers`);
// a Workspace domain is a domain.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
// Deliberately plain: one @, no spaces, a dot in the domain. The IdP decides what is real.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AZURE_REGION = /^[a-z][a-z0-9]{1,30}$/;

const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

/**
 * Validates the fields of `tabs` and nothing else, so a tab's form saves its
 * own columns without touching another tab's (packet 14). The default is
 * every tab, the whole page at once.
 */
export function validateSettings(
  form: FormData,
  current: Current,
  signedInEmail: string,
  tabs: readonly FormTab[] = FORM_TABS,
): Validated {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const on = (tab: FormTab) => tabs.includes(tab);
  const errors: Errors = {};
  const patch: Partial<SettingsPatch> = {};
  const secrets: { oidcClientSecret?: string; sttApiKey?: string; recapApiKey?: string } = {};
  let keyterms: Keyterm[] | undefined;
  let clearSttKey = false;
  let clearRecapKey = false;

  if (on('general')) {
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

    const interfaceLanguage = text('interfaceLanguage');
    if (!oneOf(INTERFACE_LANGUAGES, interfaceLanguage))
      errors.interfaceLanguage = { code: 'invalid' };

    const timeZone = text('timeZone') || 'UTC';
    if (!validTimeZone(timeZone)) errors.timeZone = { code: 'invalid' };

    Object.assign(patch, {
      productName,
      companyName: companyName || null,
      themeAccent,
      themePrimary,
      interfaceLanguage: interfaceLanguage as Settings['interfaceLanguage'],
      timeZone,
    });
  }

  if (on('login')) {
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
    if (oidcClientSecret) secrets.oidcClientSecret = oidcClientSecret;

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

    Object.assign(patch, {
      identityProvider: identityProvider as Settings['identityProvider'],
      oidcTenantId,
      oidcClientId,
      adminEmails,
    });
  }

  if (on('transcription')) {
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
      }
      // ElevenLabs takes no region: its EU residency endpoint is Enterprise-only (packet 11).
    }
    if (sttApiKey && sttProvider && STT_NEEDS_KEY.includes(sttProvider))
      secrets.sttApiKey = sttApiKey;
    clearSttKey = !sttProvider || !STT_NEEDS_KEY.includes(sttProvider);

    const aiGatewayId = text('aiGatewayId');
    if (aiGatewayId && !GATEWAY_ID.test(aiGatewayId))
      errors.aiGatewayId = { code: 'gatewayFormat' };

    const language = text('language');
    if (!oneOf(TRANSCRIPTION_LANGUAGES, language)) errors.language = { code: 'invalid' };

    const parsed = parseKeyterms(String(form.get('keyterms') ?? ''));
    if (parsed.errors[0]) errors.keyterms = parsed.errors[0];
    keyterms = parsed.terms;

    Object.assign(patch, {
      sttProvider,
      sttRegion,
      aiGatewayId: aiGatewayId || null,
      language,
      liveTranscriptDefault: form.get('liveTranscriptDefault') === 'on',
    });
  }

  if (on('recap')) {
    const recapProviderText = text('recapProvider') || 'workers-ai';
    const recapModelText = text('recapModel');
    const recapApiKey = text('recapApiKey');
    let recapProvider: RecapProvider = 'workers-ai';
    if (!oneOf(RECAP_PROVIDERS, recapProviderText)) errors.recapProvider = { code: 'invalid' };
    else {
      recapProvider = recapProviderText;
      if (recapModelText && !MODEL_ID.test(recapModelText))
        errors.recapModel = { code: 'modelFormat' };
      else if (recapProvider === 'azure-openai' && !AZURE_MODEL.test(recapModelText))
        errors.recapModel = { code: 'azureModel' };
      // A key belongs to one provider; a new provider needs its own.
      const keepsKey = current.hasRecapKey && current.recapProvider === recapProvider;
      if (NEEDS_RECAP_KEY.includes(recapProvider) && !recapApiKey && !keepsKey)
        errors.recapApiKey = { code: 'secretRequired' };
    }
    if (recapApiKey && NEEDS_RECAP_KEY.includes(recapProvider)) secrets.recapApiKey = recapApiKey;
    clearRecapKey =
      !NEEDS_RECAP_KEY.includes(recapProvider) || current.recapProvider !== recapProvider;

    Object.assign(patch, { recapProvider, recapModel: recapModelText || null });
  }

  if (on('sharing')) {
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

    const webhookAutoSend = text('webhookAutoSend') || 'off';
    if (!oneOf(WEBHOOK_AUTO_SEND, webhookAutoSend)) errors.webhookAutoSend = { code: 'invalid' };

    Object.assign(patch, {
      defaultVisibility: defaultVisibility as Settings['defaultVisibility'],
      recordingSources,
      retentionAudioDays: days('retentionAudioDays'),
      retentionTranscriptDays: days('retentionTranscriptDays'),
      mcpEnabled: form.get('mcpEnabled') === 'on',
      webhookAutoSend: webhookAutoSend as WebhookAutoSend,
    });
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    patch,
    ...(keyterms ? { keyterms } : {}),
    secrets,
    clearSttKey,
    clearRecapKey,
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

export type EndpointField = 'label' | 'url' | 'events';
export type EndpointError =
  | { code: 'required' }
  | { code: 'tooLong'; max: number }
  | { code: 'urlInvalid' }
  | { code: 'urlNotHttps' }
  | { code: 'urlPort' }
  | { code: 'urlCredentials' }
  | { code: 'urlPrivate' }
  | { code: 'atLeastOneEvent' };

const URL_ERRORS = {
  invalid: { code: 'urlInvalid' },
  not_https: { code: 'urlNotHttps' },
  port: { code: 'urlPort' },
  credentials: { code: 'urlCredentials' },
  private_host: { code: 'urlPrivate' },
  too_long: { code: 'tooLong', max: MAX_URL_LENGTH },
} as const satisfies Record<string, EndpointError>;

/**
 * A new webhook endpoint (docs/spec.md "Webhooks"): an optional label, an
 * https URL on port 443, up to 2,048 characters, that names no local or private host, and
 * at least one event. `allowLocal` lets the e2e run's receiver through.
 */
export function validateEndpoint(
  value: { label: string; url: string; events: readonly string[] },
  options: { allowLocal?: boolean } = {},
):
  | { ok: true; label: string | null; url: string; events: WebhookEvent[] }
  | { ok: false; errors: Partial<Record<EndpointField, EndpointError>> } {
  const errors: Partial<Record<EndpointField, EndpointError>> = {};
  const label = value.label.trim();
  if (label.length > MAX_LABEL_LENGTH) errors.label = { code: 'tooLong', max: MAX_LABEL_LENGTH };
  const url = value.url.trim();
  if (!url) errors.url = { code: 'required' };
  else {
    const checked = checkEndpointUrl(url, options);
    if (!checked.ok) errors.url = URL_ERRORS[checked.problem];
  }
  const events = WEBHOOK_EVENTS.filter((e) => value.events.includes(e));
  if (events.length === 0) errors.events = { code: 'atLeastOneEvent' };
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, label: label || null, url, events };
}
