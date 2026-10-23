import { getTranslations } from 'next-intl/server';
import { Section } from '@/components/settings/fields';
import { Webhooks } from '@/components/settings/webhooks';
import { requireAdmin } from '@/lib/auth/session';
import { endpointRows } from '@/lib/webhooks/rows';

/**
 * The Webhooks tab: the endpoints, each with its delivery log one level down
 * (/settings/webhooks/{id}). Which meetings go by themselves is on the
 * Sharing and retention tab. Admins only.
 */
export default async function WebhooksSettingsPage() {
  await requireAdmin('/settings/webhooks');
  const [t, endpoints] = await Promise.all([getTranslations('settings.webhooks'), endpointRows()]);
  return (
    <Section id="webhooks" heading={t('heading')} help={t('help')}>
      <Webhooks initial={endpoints} />
    </Section>
  );
}
