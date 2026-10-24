'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { describedBy, Field, Section } from './fields';
import { controlProps, TabForm } from './tab-form';
import { ThemeFields } from './theme-fields';

export interface GeneralValues {
  productName: string;
  companyName: string;
  themeAccent: string;
  themePrimary: string;
  interfaceLanguage: 'en' | 'da';
  timeZone: string;
}

/** The General tab: product name, company name, theme with its preview, interface language, time zone. */
export function GeneralForm({
  values,
  timeZones,
}: {
  values: GeneralValues;
  /** IANA names the runtime knows, UTC first. */
  timeZones: string[];
}) {
  const t = useTranslations('settings');
  const tAll = useTranslations();
  // Controlled so the theme preview follows while typing.
  const [accent, setAccent] = useState(values.themeAccent);
  const [primary, setPrimary] = useState(values.themePrimary);

  return (
    <TabForm
      tab="general"
      labels={{
        productName: t('productName.heading'),
        companyName: t('companyName.heading'),
        themeAccent: t('theme.accent'),
        themePrimary: t('theme.primary'),
        interfaceLanguage: t('interfaceLanguage.field'),
        timeZone: t('timeZone.field'),
      }}
    >
      {({ errors }) => (
        <>
          <Section
            id="product-name"
            heading={t('productName.heading')}
            help={t('productName.help')}
          >
            <Field id="productName" label={t('productName.field')} error={errors.productName}>
              <Input
                id="productName"
                name="productName"
                defaultValue={values.productName}
                aria-invalid={errors.productName ? true : undefined}
                aria-describedby={describedBy('productName', false, errors.productName)}
              />
            </Field>
          </Section>

          <Section
            id="company-name"
            heading={t('companyName.heading')}
            help={t('companyName.help')}
          >
            <Field id="companyName" label={t('companyName.field')} error={errors.companyName}>
              <Input
                id="companyName"
                name="companyName"
                defaultValue={values.companyName}
                aria-invalid={errors.companyName ? true : undefined}
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
              <select
                {...controlProps(errors, 'interfaceLanguage', true)}
                defaultValue={values.interfaceLanguage}
              >
                <option value="en">
                  {tAll('language.option', { code: 'en', name: tAll('language.en') })}
                </option>
                <option value="da">
                  {tAll('language.option', { code: 'da', name: tAll('language.da') })}
                </option>
              </select>
            </Field>
          </Section>

          <Section id="time-zone" heading={t('timeZone.heading')} help={t('timeZone.help')}>
            <Field
              id="timeZone"
              label={t('timeZone.field')}
              help={t('timeZone.note')}
              error={errors.timeZone}
            >
              <select {...controlProps(errors, 'timeZone', true)} defaultValue={values.timeZone}>
                {timeZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll('_', ' ')}
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
