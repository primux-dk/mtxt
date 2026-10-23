'use client';

import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import type { RecapProvider, SttProvider } from '@mtxt/adapters/db/schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatKeyterms, mergeKeyterms, parseKeyterms } from '@/lib/settings/keyterms';
import { STT_AVAILABLE } from '@/lib/settings/validate';
import { DataFlow } from './data-flow';
import { controlClass, describedBy, Field, SecretStatus, Section, Toggle } from './fields';
import { useProviderNames } from './provider-names';
import { controlProps, TabForm } from './tab-form';

const STT_PROVIDERS: SttProvider[] = [
  'assemblyai',
  'azure',
  'elevenlabs',
  'workers-ai-whisper',
  'local-whisper',
  'local-parakeet',
];
const NEEDS_KEY: SttProvider[] = ['assemblyai', 'azure', 'elevenlabs'];

export interface TranscriptionValues {
  sttProvider: SttProvider | null;
  sttRegion: string;
  aiGatewayId: string;
  language: string;
  keyterms: string;
  liveTranscriptDefault: boolean;
}

/**
 * The Transcription tab: the speech-to-text provider with its key and region,
 * AI Gateway, the default transcription language, keyterms with CSV import,
 * the live transcript default and the data-flow panel. The panel's recap
 * model and retention are the saved ones; they change on their own tabs.
 */
export function TranscriptionForm({
  values,
  hasSttKey,
  languages,
  recapProvider,
  retention,
}: {
  values: TranscriptionValues;
  hasSttKey: boolean;
  languages: { code: string; name: string }[];
  recapProvider: RecapProvider;
  retention: { audioDays: number; textDays: number };
}) {
  const t = useTranslations('settings');
  const tAll = useTranslations();
  const names = useProviderNames();
  const keytermsRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Controlled where the page reacts while typing: provider fields and the data flow.
  const [stt, setStt] = useState<SttProvider | ''>(values.sttProvider ?? '');
  const [gateway, setGateway] = useState(values.aiGatewayId);
  const [live, setLive] = useState(values.liveTranscriptDefault);

  const importCsv = async (file: File, changed: () => void) => {
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
    if (added > 0) {
      area.value = formatKeyterms(merged);
      changed();
    }
    setImportNote({
      ok: true,
      text:
        added > 0
          ? t('keyterms.imported', { count: added, file: file.name })
          : t('keyterms.importNone', { file: file.name }),
    });
  };

  return (
    <TabForm
      tab="transcription"
      labels={{
        sttProvider: t('stt.provider'),
        sttApiKey: t('stt.apiKey'),
        sttRegion: t('stt.region'),
        aiGatewayId: tAll('stt.gateway.field'),
        language: t('stt.language'),
        keyterms: t('keyterms.field'),
      }}
    >
      {({ errors, changed }) => (
        <>
          <Section id="stt" heading={t('stt.heading')} help={t('stt.help')}>
            <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
              <Field
                id="sttProvider"
                label={t('stt.provider')}
                error={errors.sttProvider}
                className="col-span-full"
              >
                <select
                  {...controlProps(errors, 'sttProvider')}
                  value={stt}
                  onChange={(e) => setStt(e.target.value as SttProvider)}
                >
                  <option value="">{t('stt.none')}</option>
                  {STT_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {names.stt(p)}
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
                    id="sttApiKey"
                    name="sttApiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      hasSttKey && stt === values.sttProvider ? t('secret.replace') : undefined
                    }
                    aria-invalid={errors.sttApiKey ? true : undefined}
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
                    aria-invalid={errors.sttRegion ? true : undefined}
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
                  aria-invalid={errors.aiGatewayId ? true : undefined}
                  aria-describedby={describedBy('aiGatewayId', true, errors.aiGatewayId)}
                />
              </Field>
              <Field
                id="language"
                label={t('stt.language')}
                error={errors.language}
                className="col-span-full"
              >
                <select {...controlProps(errors, 'language')} defaultValue={values.language}>
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {tAll('language.option', { code: l.code, name: l.name })}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
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
                  {...controlProps(errors, 'keyterms', true)}
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
                    if (file) void importCsv(file, changed);
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

          <Section
            id="live-transcript"
            heading={t('defaults.liveHeading')}
            help={t('defaults.help')}
          >
            <Toggle
              id="liveTranscriptDefault"
              name="liveTranscriptDefault"
              label={t('defaults.liveDefault')}
              help={t('defaults.liveDefaultHelp')}
              pressed={live}
              onChange={setLive}
            />
          </Section>

          <DataFlow
            provider={stt || null}
            providerName={stt ? names.stt(stt) : ''}
            recapName={names.recap(recapProvider)}
            gateway={Boolean(gateway.trim())}
            supported={STT_AVAILABLE.map(names.stt)}
            available={Boolean(stt) && STT_AVAILABLE.includes(stt as SttProvider)}
            audioDays={retention.audioDays}
            textDays={retention.textDays}
          />
        </>
      )}
    </TabForm>
  );
}
