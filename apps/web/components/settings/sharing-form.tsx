'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CAPTURE_SOURCES as SOURCES, type Visibility } from '@mtxt/adapters/db/schema';
import { Input } from '@/components/ui/input';
import { describedBy, Field, FieldError, Section, Toggle } from './fields';
import { controlProps, TabForm } from './tab-form';

const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: 'visibility.private',
  shared: 'settings.defaults.visibilityShared',
  company: 'settings.defaults.visibilityCompany',
};

export interface SharingValues {
  defaultVisibility: Visibility;
  recordingSources: string[];
  retentionAudioDays: number;
  retentionTranscriptDays: number;
  mcpEnabled: boolean;
  webhookAutoSend: 'off' | 'company' | 'shared';
}

/**
 * The Sharing and retention tab: default visibility, recording sources,
 * retention, the MCP server and which meetings webhooks send by themselves.
 */
export function SharingForm({ values, mcpUrl }: { values: SharingValues; mcpUrl: string }) {
  const t = useTranslations('settings');
  const tAll = useTranslations();
  const [mcp, setMcp] = useState(values.mcpEnabled);

  return (
    <TabForm
      tab="sharing"
      labels={{
        defaultVisibility: t('defaults.visibility'),
        recordingSources: t('sources.heading'),
        retentionAudioDays: t('retention.audio'),
        retentionTranscriptDays: t('retention.text'),
        webhookAutoSend: t('webhooks.autoSend'),
      }}
    >
      {({ errors }) => (
        <>
          <Section id="visibility" heading={t('defaults.visibilityHeading')}>
            <Field
              id="defaultVisibility"
              label={t('defaults.visibility')}
              help={t('defaults.visibilityHelp')}
              error={errors.defaultVisibility}
            >
              <select
                {...controlProps(errors, 'defaultVisibility', true)}
                defaultValue={values.defaultVisibility}
              >
                {(Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => (
                  <option key={v} value={v}>
                    {tAll(VISIBILITY_LABELS[v])}
                  </option>
                ))}
              </select>
            </Field>
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
                    {t(`sources.${source}`)}
                  </label>
                ))}
              </div>
              <FieldError id="recordingSources" error={errors.recordingSources} />
            </fieldset>
          </Section>

          <Section id="retention" heading={t('retention.heading')} help={t('retention.help')}>
            <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
              {(['retentionAudioDays', 'retentionTranscriptDays'] as const).map((field) => (
                <Field
                  key={field}
                  id={field}
                  label={t(field === 'retentionAudioDays' ? 'retention.audio' : 'retention.text')}
                  error={errors[field]}
                >
                  <Input
                    id={field}
                    name={field}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    defaultValue={values[field]}
                    aria-invalid={errors[field] ? true : undefined}
                    aria-describedby={describedBy(field, false, errors[field])}
                  />
                </Field>
              ))}
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
            <div className="mt-4 grid gap-2 text-xs text-muted-foreground" data-testid="mcp-setup">
              <p>
                {t.rich('mcp.url', {
                  url: () => (
                    <code className="font-mono text-[13px] text-foreground [overflow-wrap:anywhere]">
                      {mcpUrl}
                    </code>
                  ),
                })}
              </p>
              <ul className="grid list-disc gap-1 pl-4">
                <li>{t('mcp.claude')}</li>
                <li>
                  {t.rich('mcp.claudeCode', {
                    command: () => (
                      <code className="font-mono [overflow-wrap:anywhere]">
                        claude mcp add --transport http mtxt {mcpUrl}
                      </code>
                    ),
                  })}
                </li>
                <li>{t('mcp.chatgpt')}</li>
                <li>{t('mcp.cursor')}</li>
              </ul>
              <p>{t('mcp.signIn')}</p>
            </div>
          </Section>

          <Section id="auto-send" heading={t('webhooks.heading')} help={t('webhooks.help')}>
            <Field
              id="webhookAutoSend"
              label={t('webhooks.autoSend')}
              help={t('webhooks.autoSendHelp')}
              error={errors.webhookAutoSend}
            >
              <select
                {...controlProps(errors, 'webhookAutoSend', true)}
                defaultValue={values.webhookAutoSend}
              >
                {(['off', 'company', 'shared'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`webhooks.autoSendOptions.${v}`)}
                  </option>
                ))}
              </select>
            </Field>
          </Section>
        </>
      )}
    </TabForm>
  );
}
