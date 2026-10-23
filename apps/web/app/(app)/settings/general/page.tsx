import { GeneralForm } from '@/components/settings/general-form';
import { requireAdmin } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';

/** Figure 07, the General tab. Admins only; anyone else gets the 403 page. */
export default async function GeneralPage() {
  await requireAdmin('/settings/general');
  const settings = await getInstallSettings();
  return (
    <GeneralForm
      values={{
        productName: settings.productName,
        companyName: settings.companyName ?? '',
        themeAccent: settings.themeAccent,
        themePrimary: settings.themePrimary,
        interfaceLanguage: settings.interfaceLanguage,
      }}
    />
  );
}
