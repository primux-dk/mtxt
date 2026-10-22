import { getTranslations } from 'next-intl/server';
import { PageTitle } from '@/components/page-title';

export default async function SettingsPage() {
  const t = await getTranslations('settings');
  // The settings page itself arrives in packet 2.
  return <PageTitle title={t('title')} />;
}
