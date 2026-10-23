'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { RecapProvider } from '@mtxt/adapters/db/schema';
import type { TemplateRow } from '@/app/(app)/settings/actions';
import { Input } from '@/components/ui/input';
import { DEFAULT_RECAP_MODEL, NEEDS_RECAP_KEY, RECAP_PROVIDER_IDS } from '@/lib/recap/models';
import { describedBy, Field, SecretStatus, Section } from './fields';
import { useProviderNames } from './provider-names';
import { controlProps, TabForm } from './tab-form';
import { Templates } from './templates';

/**
 * The Recap tab: the recap model with its key, and the recap templates.
 * Templates save on their own actions; "Save" saves the model.
 */
export function RecapForm({
  values,
  hasRecapKey,
  templates,
}: {
  values: { recapProvider: RecapProvider; recapModel: string };
  hasRecapKey: boolean;
  templates: TemplateRow[];
}) {
  const t = useTranslations('settings');
  const names = useProviderNames();
  const [recap, setRecap] = useState<RecapProvider>(values.recapProvider);

  return (
    <TabForm
      tab="recap"
      labels={{
        recapProvider: t('recap.provider'),
        recapModel: t('recap.model'),
        recapApiKey: t('recap.apiKey'),
      }}
    >
      {({ errors, secretsKey }) => (
        <>
          <Section id="recap" heading={t('recap.heading')} help={t('recap.help')}>
            <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
              <Field
                id="recapProvider"
                label={t('recap.provider')}
                error={errors.recapProvider}
                className="col-span-full"
              >
                <select
                  {...controlProps(errors, 'recapProvider')}
                  value={recap}
                  onChange={(e) => setRecap(e.target.value as RecapProvider)}
                >
                  {RECAP_PROVIDER_IDS.map((p) => (
                    <option key={p} value={p}>
                      {names.recap(p)}
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
                  aria-invalid={errors.recapModel ? true : undefined}
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
                      hasRecapKey && recap === values.recapProvider
                        ? t('secret.replace')
                        : undefined
                    }
                    aria-invalid={errors.recapApiKey ? true : undefined}
                    aria-describedby={describedBy('recapApiKey', true, errors.recapApiKey)}
                  />
                </Field>
              ) : (
                <p className="self-center text-sm text-muted-foreground">{t('recap.noKey')}</p>
              )}
            </div>
          </Section>

          <Section id="templates" heading={t('templates.heading')} help={t('templates.help')}>
            <Templates initial={templates} />
          </Section>
        </>
      )}
    </TabForm>
  );
}
