'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import type { IdentityProvider } from '@mtxt/adapters/db/schema';
import { Input } from '@/components/ui/input';
import { controlClass, describedBy, Field, SecretStatus, Section } from './fields';
import { controlProps, TabForm } from './tab-form';

export interface LoginValues {
  identityProvider: IdentityProvider | null;
  oidcTenantId: string;
  oidcClientId: string;
  adminEmails: string;
}

/** The Login tab: the identity provider with its fields, and the admins. */
export function LoginForm({
  values,
  hasClientSecret,
  redirectUris,
}: {
  values: LoginValues;
  hasClientSecret: boolean;
  redirectUris: Record<IdentityProvider, string>;
}) {
  const t = useTranslations('settings');
  // Controlled: the tenant field's label and the redirect URI follow the provider.
  const [idp, setIdp] = useState<IdentityProvider | ''>(values.identityProvider ?? '');

  return (
    <TabForm
      tab="login"
      labels={{
        identityProvider: t('login.provider'),
        oidcTenantId: idp === 'google' ? t('login.domain') : t('login.tenantId'),
        oidcClientId: t('login.clientId'),
        oidcClientSecret: t('login.clientSecret'),
        adminEmails: t('admins.field'),
      }}
    >
      {({ errors }) => (
        <>
          <Section id="login" heading={t('login.heading')} help={t('login.help')}>
            <div className="grid grid-cols-2 gap-4 max-shell:grid-cols-1">
              <Field
                id="identityProvider"
                label={t('login.provider')}
                error={errors.identityProvider}
                className="col-span-full"
              >
                <select
                  {...controlProps(errors, 'identityProvider')}
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
                  aria-invalid={errors.oidcTenantId ? true : undefined}
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
                  aria-invalid={errors.oidcClientId ? true : undefined}
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
                  id="oidcClientSecret"
                  name="oidcClientSecret"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasClientSecret ? t('secret.replace') : undefined}
                  aria-invalid={errors.oidcClientSecret ? true : undefined}
                  aria-describedby={describedBy('oidcClientSecret', true, errors.oidcClientSecret)}
                />
              </Field>
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
                {...controlProps(errors, 'adminEmails', true)}
                rows={3}
                defaultValue={values.adminEmails}
                spellCheck={false}
                autoComplete="off"
                className={cn(controlClass, 'min-h-24 resize-y')}
              />
            </Field>
          </Section>
        </>
      )}
    </TabForm>
  );
}
