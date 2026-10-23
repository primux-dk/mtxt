import { listTemplates } from '@mtxt/adapters';
import { RecapForm } from '@/components/settings/recap-form';
import { requireAdmin } from '@/lib/auth/session';
import { getAdapters, getInstallSettings } from '@/lib/install';

/** The Recap tab: the recap model and the templates. Admins only. */
export default async function RecapSettingsPage() {
  await requireAdmin('/settings/recap');
  const [settings, { db, installId }] = await Promise.all([getInstallSettings(), getAdapters()]);
  const templates = await listTemplates(db, installId);
  return (
    <RecapForm
      values={{ recapProvider: settings.recapProvider, recapModel: settings.recapModel ?? '' }}
      hasRecapKey={Boolean(settings.recapApiKey)}
      templates={templates.map(({ id, name, bodyMd, isDefault }) => ({
        id,
        name,
        bodyMd,
        isDefault,
      }))}
    />
  );
}
