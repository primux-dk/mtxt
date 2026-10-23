'use client';

import { TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import type {
  IdentityProvider,
  RecapProvider,
  SttProvider,
  Visibility,
} from '@mtxt/adapters/db/schema';
import {
  saveSettingsAction,
  type SaveResult,
  type TemplateRow,
} from '@/app/(app)/settings/actions';
import { PageTitle } from '@/components/page-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatKeyterms, mergeKeyterms, parseKeyterms } from '@/lib/settings/keyterms';
import { STT_AVAILABLE, type Field as FieldName } from '@/lib/settings/validate';
import { DEFAULT_RECAP_MODEL, NEEDS_RECAP_KEY, RECAP_PROVIDER_IDS } from '@/lib/recap/models';
import { DataFlow } from './data-flow';
import {
  controlClass,
  describedBy,
  Field,
  FieldError,
  SecretStatus,
  Section,
  Toggle,
} from './fields';
import { Templates } from './templates';
import { ThemeFields } from './theme-fields';
import { Webhooks } from './webhooks';
import type { EndpointRow } from '@/lib/webhooks/rows';

const STT_PROVIDERS: SttProvider[] = [
  'assemblyai',
  'azure',
  'elevenlabs',
  'workers-ai-whisper',
  'local-whisper',
  'local-parakeet',
];
const NEEDS_KEY: SttProvider[] = ['assemblyai', 'azure', 'elevenlabs'];
const SOURCES = ['desktop', 'upload', 'browser', 'teams', 'meet'] as const;
const SOURCE_LABELS = {
  desktop: 'desktop',
  upload: 'upload',
  browser: 'browser',
  teams: 'onedrive',
  meet: 'drive',
} as const;
const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: 'visibility.private',
  shared: 'settings.defaults.visibilityShared',
  company: 'settings.defaults.visibilityCompany',
};

export interface SettingsFormProps {
  values: {
    productName: string;
    companyName: string;
    themeAccent: string;
    themePrimary: string;
    identityProvider: IdentityProvider | null;
    oidcTenantId: string;
    oidcClientId: string;
    sttProvider: SttProvider | null;
    sttRegion: string;
    aiGatewayId: string;
    language: string;
    recapProvider: RecapProvider;
    recapModel: string;
    interfaceLanguage: 'en' | 'da';
    keyterms: string;
    liveTranscriptDefault: boolean;
    defaultVisibility: Visibility;
    recordingSources: string[];
    retentionAudioDays: number;
    retentionTranscriptDays: number;
    mcpEnabled: boolean;
    webhookAutoSend: 'off' | 'company' | 'shared';
    adminEmails: string;
  };
  hasClientSecret: boolean;
  hasSttKey: boolean;
  hasRecapKey: boolean;
  redirectUris: Record<IdentityProvider, string>;
  languages: { code: string; name: string }[];
  templates: TemplateRow[];
  endpoints: EndpointRow[];
}

/** The control each field's summary link moves focus to. */
const fieldId = (field: FieldName) => (field === 'recordingSources' ? 'source-desktop' : field);

/**
 * Figure 07, the whole admin surface. One primary, "Save settings", sends the
 * form to a server action. Errors sit at each field and are listed at the
 * top with links (behaviour rule 9); what was typed stays, because the form
 * is never reset. Templates save on their own actions.
 */
export function SettingsForm({
  values,
  hasClientSecret,
  hasSttKey,
  hasRecapKey,
  redirectUris,
  languages,
  templates,
  endpoints,
}: SettingsFormProps) {
  const t = useTranslations('settings');
  const tAll = useTranslations();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SaveResult | null>(null);
  const [secretsKey, setSecretsKey] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  const keytermsRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Controlled where the page reacts while typing: theme preview, provider fields, data flow.
  const [accent, setAccent] = useState(values.themeAccent);
  const [primary, setPrimary] = useState(values.themePrimary);
  const [idp, setIdp] = useState<IdentityProvider | ''>(values.identityProvider ?? '');
  const [stt, setStt] = useState<SttProvider | ''>(values.sttProvider ?? '');
  const [recap, setRecap] = useState<RecapProvider>(values.recapProvider);
  const [gateway, setGateway] = useState(values.aiGatewayId);
  const [live, setLive] = useState(values.liveTranscriptDefault);
  const [mcp, setMcp] = useState(values.mcpEnabled);
  const [audioDays, setAudioDays] = useState(String(values.retentionAudioDays));
  const [textDays, setTextDays] = useState(String(values.retentionTranscriptDays));

  const errors = result?.status === 'invalid' ? result.errors : {};
  const errorFields = Object.keys(errors) as FieldName[];

  const providerName = (p: SttProvider) =>
    p === 'local-whisper'
      ? t('stt.local', { model: 'Whisper' })
      : p === 'local-parakeet'
        ? t('stt.local', { model: 'Parakeet' })
        : t(`stt.providers.${p === 'workers-ai-whisper' ? 'workersAi' : p}`);
  const recapName = (p: RecapProvider) =>
    t(
      `recap.providers.${p === 'workers-ai' ? 'workersAi' : p === 'azure-openai' ? 'azureOpenai' : p}`,
    );

  const LABELS: Record<FieldName, string> = {
    productName: t('productName.heading'),
    companyName: t('companyName.heading'),
    themeAccent: t('theme.accent'),
    themePrimary: t('theme.primary'),
    identityProvider: t('login.provider'),
    oidcTenantId: idp === 'google' ? t('login.domain') : t('login.tenantId'),
    oidcClientId: t('login.clientId'),
    oidcClientSecret: t('login.clientSecret'),
    sttProvider: t('stt.provider'),
    sttApiKey: t('stt.apiKey'),
    sttRegion: t('stt.region'),
    aiGatewayId: tAll('stt.gateway.field'),
    language: t('stt.language'),
    recapProvider: t('recap.provider'),
    recapModel: t('recap.model'),
    recapApiKey: t('recap.apiKey'),
    interfaceLanguage: t('interfaceLanguage.field'),
    keyterms: t('keyterms.field'),
    defaultVisibility: t('defaults.visibility'),
    recordingSources: t('sources.heading'),
    retentionAudioDays: t('retention.audio'),
    retentionTranscriptDays: t('retention.text'),
    webhookAutoSend: t('webhooks.autoSend'),
    adminEmails: t('admins.field'),
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const form = new FormData(e.currentTarget);
    startTransition(async () => {
      const next = await saveSettingsAction(form).catch((): SaveResult => ({
        status: 'error',
        message: t('errors.saveFailed'),
      }));
      setResult(next);
      if (next.status === 'saved') setSecretsKey((k) => k + 1);
      // The summary takes focus so a keyboard or screen reader user hears what to fix.
      if (next.status !== 'saved') requestAnimationFrame(() => summaryRef.current?.focus());
    });
  };

  const importCsv = async (file: File) => {
    const parsed = parseKeyterms(await file.text());
    const error = parsed.errors[0];
    if (error) {
      const reason =
        error.code === 'tooMany'
          ? t('errors.tooMany', { max: error.max })
          : error.code === 'badBoost'
            ? t('errors.badBoost', { record: error.record, value: error.value, max: error.max })
            : error.code === 'termTooLong'
              ? t('errors.termTooLong', { record: error.record, max: error.max })
              : t(`errors.${error.code}`, { record: error.record });
      setImportNote({ ok: false, text: t('keyterms.importFailed', { file: file.name, reason }) });
      return;
    }
    const area = keytermsRef.current!;
    const current = parseKeyterms(area.value).terms;
    const merged = mergeKeyterms(current, parsed.terms);
    const added = merged.length - current.length;
    if (added > 0) area.value = formatKeyterms(merged);
    setImportNote({
      ok: true,
      text:
        added > 0
          ? t('keyterms.imported', { count: added, file: file.name })
          : t('keyterms.importNone', { file: file.name }),
    });
  };

  const invalid = (field: FieldName) => (errors[field] ? true : undefined);
  const select = (field: FieldName, help = false) => ({
    id: field,
    name: field,
    'aria-invalid': invalid(field),
    'aria-describedby': describedBy(field, help, errors[field]),
    className: controlClass,
  });

  return (
    <>
      <div className="mb-8 flex items-start justify-between gap-3 max-shell:mb-6">
        <div className="min-w-0">
          {values.companyName && (
            <p className="mb-2 text-xs font-[550] tracking-[0.1em] text-muted-foreground uppercase [overflow-wrap:anywhere]">
              {values.companyName}
            </p>
          )}
          <PageTitle title={t('title')} subheading={t('subheading')} />
        </div>
        <span className="mt-2 inline-flex shrink-0 items-center rounded-pill border border-border bg-card px-2.5 py-0.5 text-xs">
          {t('adminBadge')}
        </span>
      </div>

      <div
        ref={summaryRef}
        tabIndex={-1}
        role={result && result.status !== 'saved' ? 'alert' : undefined}
        className="outline-none focus-visible:outline-2"
      >
        {result?.status === 'invalid' && (
          <div className="mb-6 rounded-card border border-destructive p-4 text-sm">
            <p className="flex gap-2 font-[550] text-destructive">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
                strokeWidth={1.5}
              />
              {t('errors.summary', { count: errorFields.length })}
            </p>
            <ul className="mt-2 grid gap-1 pl-6">
              {errorFields.map((field) => (
                <li key={field}>
                  <a
                    href={`#${fieldId(field)}`}
                    className="underline underline-offset-4"
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(fieldId(field));
                      el?.focus();
                      el?.scrollIntoView({ block: 'center' });
                    }}
                  >
                    {LABELS[field]}
                  </a>
                  : {errors[field]}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result?.status === 'error' && (
          <p className="mb-6 flex gap-2 rounded-card border border-destructive p-4 text-sm text-destructive">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.5}
            />
            {result.message}
          </p>
        )}
      </div>

      <form onSubmit={submit} noValidate aria-label={t('title')}>
        <Section id="product-name" heading={t('productName.heading')} help={t('productName.help')}>
          <Field id="productName" label={t('productName.field')} error={errors.productName}>
            <Input
              id="productName"
              name="productName"
              defaultValue={values.productName}
              aria-invalid={invalid('productName')}
              aria-describedby={describedBy('productName', false, errors.productName)}
            />
          </Field>
        </Section>

        <Section id="company-name" heading={t('companyName.heading')} help={t('companyName.help')}>
          <Field id="companyName" label={t('companyName.field')} error={errors.companyName}>
            <Input
              id="companyName"
              name="companyName"
              defaultValue={values.companyName}
              aria-invalid={invalid('companyName')}
              aria-describedby={describedBy('companyName', false, errors.companyName)}
            />
          </Field>
        </Section>

        <Section id="theme" heading={t('theme.heading')} help={t('theme.help')}>
          <ThemeFields
            accent={accent}
            primary={primary}
            onAccent={setAccent}
            onPrimary={setPrimary}
            errors={{ themeAccent: errors.themeAccent, themePrimary: errors.themePrimary }}
          />
        </Section>

        <Section id="login" heading={t('login.heading')} help={t('login.help')}>
          <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
            <Field
              id="identityProvider"
              label={t('login.provider')}
              error={errors.identityProvider}
              className="col-span-full"
            >
              <select
                {...select('identityProvider')}
                value={idp}
                onChange={(e) => setIdp(e.target.value as IdentityProvider)}
              >
                {!values.identityProvider && (
                  <option value="" disabled>
                    {t('login.choose')}
                  </option>
                )}
                <option value="entra">{t('login.providers.entra')}</option>
                <option value="google">{t('login.providers.google')}</option>
              </select>
            </Field>
            <Field
              id="oidcTenantId"
              label={idp === 'google' ? t('login.domain') : t('login.tenantId')}
              help={idp === 'google' ? t('login.domainHelp') : t('login.tenantHelp')}
              error={errors.oidcTenantId}
            >
              <Input
                id="oidcTenantId"
                name="oidcTenantId"
                defaultValue={values.oidcTenantId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid('oidcTenantId')}
                aria-describedby={describedBy('oidcTenantId', true, errors.oidcTenantId)}
              />
            </Field>
            <Field id="oidcClientId" label={t('login.clientId')} error={errors.oidcClientId}>
              <Input
                id="oidcClientId"
                name="oidcClientId"
                defaultValue={values.oidcClientId}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid('oidcClientId')}
                aria-describedby={describedBy('oidcClientId', false, errors.oidcClientId)}
              />
            </Field>
            <Field
              id="oidcClientSecret"
              label={t('login.clientSecret')}
              extra={
                <SecretStatus
                  set={hasClientSecret}
                  labels={{ set: t('secret.set'), notSet: t('secret.notSet') }}
                />
              }
              help={
                idp
                  ? t('login.secretHelpRedirect', { url: redirectUris[idp] })
                  : t('login.secretHelp')
              }
              error={errors.oidcClientSecret}
              className="col-span-full"
            >
              <Input
                key={secretsKey}
                id="oidcClientSecret"
                name="oidcClientSecret"
                type="password"
                autoComplete="new-password"
                placeholder={hasClientSecret ? t('secret.replace') : undefined}
                aria-invalid={invalid('oidcClientSecret')}
                aria-describedby={describedBy('oidcClientSecret', true, errors.oidcClientSecret)}
              />
            </Field>
          </div>
        </Section>

        <Section id="stt" heading={t('stt.heading')} help={t('stt.help')}>
          <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
            <Field
              id="sttProvider"
              label={t('stt.provider')}
              error={errors.sttProvider}
              className="col-span-full"
            >
              <select
                {...select('sttProvider')}
                value={stt}
                onChange={(e) => setStt(e.target.value as SttProvider)}
              >
                <option value="">{t('stt.none')}</option>
                {STT_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {providerName(p)}
                  </option>
                ))}
              </select>
            </Field>
            {stt && NEEDS_KEY.includes(stt) ? (
              <Field
                id="sttApiKey"
                label={t('stt.apiKey')}
                extra={
                  <SecretStatus
                    set={hasSttKey && stt === values.sttProvider}
                    labels={{ set: t('secret.set'), notSet: t('secret.notSet') }}
                  />
                }
                help={t('login.secretHelp')}
                error={errors.sttApiKey}
              >
                <Input
                  key={secretsKey}
                  id="sttApiKey"
                  name="sttApiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    hasSttKey && stt === values.sttProvider ? t('secret.replace') : undefined
                  }
                  aria-invalid={invalid('sttApiKey')}
                  aria-describedby={describedBy('sttApiKey', true, errors.sttApiKey)}
                />
              </Field>
            ) : (
              stt && <p className="self-center text-sm text-muted-foreground">{t('stt.noKey')}</p>
            )}
            {stt === 'azure' && (
              <Field
                id="sttRegion"
                label={t('stt.region')}
                help={t('stt.regionHelp')}
                error={errors.sttRegion}
              >
                <Input
                  id="sttRegion"
                  name="sttRegion"
                  defaultValue={values.sttProvider === 'azure' ? values.sttRegion : ''}
                  placeholder={t('stt.azurePlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={invalid('sttRegion')}
                  aria-describedby={describedBy('sttRegion', true, errors.sttRegion)}
                />
              </Field>
            )}
            <Field
              id="aiGatewayId"
              label={tAll('stt.gateway.field')}
              help={tAll('stt.gateway.help')}
              error={errors.aiGatewayId}
              className="col-span-full"
            >
              <Input
                id="aiGatewayId"
                name="aiGatewayId"
                value={gateway}
                onChange={(e) => setGateway(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid('aiGatewayId')}
                aria-describedby={describedBy('aiGatewayId', true, errors.aiGatewayId)}
              />
            </Field>
            <Field
              id="language"
              label={t('stt.language')}
              error={errors.language}
              className="col-span-full"
            >
              <select {...select('language')} defaultValue={values.language}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {tAll('language.option', { code: l.code, name: l.name })}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section id="recap" heading={t('recap.heading')} help={t('recap.help')}>
          <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
            <Field
              id="recapProvider"
              label={t('recap.provider')}
              error={errors.recapProvider}
              className="col-span-full"
            >
              <select
                {...select('recapProvider')}
                value={recap}
                onChange={(e) => setRecap(e.target.value as RecapProvider)}
              >
                {RECAP_PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {recapName(p)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="recapModel"
              label={t('recap.model')}
              help={
                recap === 'azure-openai'
                  ? t('recap.modelHelpAzure')
                  : t('recap.modelHelp', { model: DEFAULT_RECAP_MODEL[recap] })
              }
              error={errors.recapModel}
            >
              <Input
                key={recap}
                id="recapModel"
                name="recapModel"
                defaultValue={recap === values.recapProvider ? values.recapModel : ''}
                placeholder={DEFAULT_RECAP_MODEL[recap] || 'resource/deployment'}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid('recapModel')}
                aria-describedby={describedBy('recapModel', true, errors.recapModel)}
              />
            </Field>
            {NEEDS_RECAP_KEY.includes(recap) ? (
              <Field
                id="recapApiKey"
                label={t('recap.apiKey')}
                extra={
                  <SecretStatus
                    set={hasRecapKey && recap === values.recapProvider}
                    labels={{ set: t('secret.set'), notSet: t('secret.notSet') }}
                  />
                }
                help={t('login.secretHelp')}
                error={errors.recapApiKey}
              >
                <Input
                  key={`${secretsKey}-${recap}`}
                  id="recapApiKey"
                  name="recapApiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    hasRecapKey && recap === values.recapProvider ? t('secret.replace') : undefined
                  }
                  aria-invalid={invalid('recapApiKey')}
                  aria-describedby={describedBy('recapApiKey', true, errors.recapApiKey)}
                />
              </Field>
            ) : (
              <p className="self-center text-sm text-muted-foreground">{t('recap.noKey')}</p>
            )}
          </div>
        </Section>

        <Section
          id="interface-language"
          heading={t('interfaceLanguage.heading')}
          help={t('interfaceLanguage.help')}
        >
          <Field
            id="interfaceLanguage"
            label={t('interfaceLanguage.field')}
            help={t('interfaceLanguage.note')}
            error={errors.interfaceLanguage}
          >
            <select {...select('interfaceLanguage', true)} defaultValue={values.interfaceLanguage}>
              <option value="en">
                {tAll('language.option', { code: 'en', name: tAll('language.en') })}
              </option>
              <option value="da">
                {tAll('language.option', { code: 'da', name: tAll('language.da') })}
              </option>
            </select>
          </Field>
        </Section>

        <Section id="keyterms" heading={t('keyterms.heading')} help={t('keyterms.help')}>
          <div className="grid gap-4">
            <Field
              id="keyterms"
              label={t('keyterms.field')}
              help={t('keyterms.fieldHelp')}
              error={errors.keyterms}
            >
              <textarea
                ref={keytermsRef}
                {...select('keyterms', true)}
                rows={5}
                defaultValue={values.keyterms}
                spellCheck={false}
                className={cn(controlClass, 'min-h-24 resize-y')}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => fileRef.current?.click()}>
                <Upload aria-hidden="true" />
                {t('keyterms.import')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importCsv(file);
                  e.target.value = '';
                }}
              />
              <p
                role="status"
                className={cn(
                  'text-sm',
                  importNote && !importNote.ok ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {importNote?.text}
              </p>
            </div>
          </div>
        </Section>

        <Section id="defaults" heading={t('defaults.heading')} help={t('defaults.help')}>
          <div className="grid gap-4">
            <Toggle
              id="liveTranscriptDefault"
              name="liveTranscriptDefault"
              label={t('defaults.liveDefault')}
              help={t('defaults.liveDefaultHelp')}
              pressed={live}
              onChange={setLive}
            />
            <Field
              id="defaultVisibility"
              label={t('defaults.visibility')}
              help={t('defaults.visibilityHelp')}
              error={errors.defaultVisibility}
            >
              <select
                {...select('defaultVisibility', true)}
                defaultValue={values.defaultVisibility}
              >
                {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => (
                  <option key={v} value={v}>
                    {tAll(VISIBILITY_LABELS[v])}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>

        <Section id="sources" heading={t('sources.heading')} help={t('sources.help')}>
          <fieldset
            aria-describedby={errors.recordingSources ? 'recordingSources-error' : undefined}
          >
            <legend className="sr-only">{t('sources.heading')}</legend>
            <div className="grid gap-3">
              {SOURCES.map((source) => (
                <label
                  key={source}
                  className="flex min-h-6 items-center gap-2 text-sm max-shell:min-h-11"
                >
                  <input
                    id={`source-${source}`}
                    type="checkbox"
                    name="recordingSources"
                    value={source}
                    defaultChecked={values.recordingSources.includes(source)}
                    className="size-4 accent-[var(--accent-strong)]"
                  />
                  {t(`sources.${SOURCE_LABELS[source]}`)}
                </label>
              ))}
            </div>
            <FieldError id="recordingSources" error={errors.recordingSources} />
          </fieldset>
        </Section>

        <Section id="templates" heading={t('templates.heading')} help={t('templates.help')}>
          <Templates initial={templates} />
        </Section>

        <Section id="retention" heading={t('retention.heading')} help={t('retention.help')}>
          <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
            <Field
              id="retentionAudioDays"
              label={t('retention.audio')}
              error={errors.retentionAudioDays}
            >
              <Input
                id="retentionAudioDays"
                name="retentionAudioDays"
                type="number"
                inputMode="numeric"
                min={1}
                value={audioDays}
                onChange={(e) => setAudioDays(e.target.value)}
                aria-invalid={invalid('retentionAudioDays')}
                aria-describedby={describedBy(
                  'retentionAudioDays',
                  false,
                  errors.retentionAudioDays,
                )}
              />
            </Field>
            <Field
              id="retentionTranscriptDays"
              label={t('retention.text')}
              error={errors.retentionTranscriptDays}
            >
              <Input
                id="retentionTranscriptDays"
                name="retentionTranscriptDays"
                type="number"
                inputMode="numeric"
                min={1}
                value={textDays}
                onChange={(e) => setTextDays(e.target.value)}
                aria-invalid={invalid('retentionTranscriptDays')}
                aria-describedby={describedBy(
                  'retentionTranscriptDays',
                  false,
                  errors.retentionTranscriptDays,
                )}
              />
            </Field>
          </div>
        </Section>

        <Section id="mcp" heading={t('mcp.heading')} help={t('mcp.help')}>
          <Toggle
            id="mcpEnabled"
            name="mcpEnabled"
            label={t('mcp.server')}
            help={t('mcp.serverHelp')}
            pressed={mcp}
            onChange={setMcp}
          />
        </Section>

        <Section id="webhooks" heading={t('webhooks.heading')} help={t('webhooks.help')}>
          <div className="grid gap-6">
            <Field
              id="webhookAutoSend"
              label={t('webhooks.autoSend')}
              help={t('webhooks.autoSendHelp')}
              error={errors.webhookAutoSend}
            >
              <select {...select('webhookAutoSend', true)} defaultValue={values.webhookAutoSend}>
                {(['off', 'company', 'shared'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`webhooks.autoSendOptions.${v}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Webhooks initial={endpoints} />
          </div>
        </Section>

        <Section id="admins" heading={t('admins.heading')} help={t('admins.help')}>
          <Field
            id="adminEmails"
            label={t('admins.field')}
            help={t('admins.fieldHelp')}
            error={errors.adminEmails}
          >
            <textarea
              {...select('adminEmails', true)}
              rows={3}
              defaultValue={values.adminEmails}
              spellCheck={false}
              autoComplete="off"
              className={cn(controlClass, 'min-h-24 resize-y')}
            />
          </Field>
        </Section>

        <DataFlow
          provider={stt || null}
          providerName={stt ? providerName(stt) : ''}
          recapName={recapName(recap)}
          gateway={Boolean(gateway.trim())}
          supported={STT_AVAILABLE.map(providerName)}
          available={Boolean(stt) && STT_AVAILABLE.includes(stt as SttProvider)}
          audioDays={Number(audioDays) || 0}
          textDays={Number(textDays) || 0}
        />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
          <p role="status" className="text-xs text-muted-foreground">
            {result?.status === 'saved' ? result.message : t('footer')}
          </p>
          <Button type="submit" variant="primary" aria-busy={pending || undefined}>
            {t('save')}
          </Button>
        </div>
      </form>
    </>
  );
}
