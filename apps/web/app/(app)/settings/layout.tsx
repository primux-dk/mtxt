import { getTranslations } from 'next-intl/server';
import { PageTitle } from '@/components/page-title';
import { SettingsTabs } from '@/components/settings/settings-tabs';
import { getInstallSettings } from '@/lib/install';

/**
 * The settings page around every tab: the title, then the tab strip, then
 * the tab's route. Each page checks admin itself; the middleware has already
 * answered anyone else with the 403 page.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const [{ companyName }, t] = await Promise.all([
    getInstallSettings(),
    getTranslations('settings'),
  ]);
  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3 max-shell:mb-5">
        <div className="min-w-0">
          {companyName && (
            <p className="mb-2 text-xs font-[550] tracking-[0.1em] text-muted-foreground uppercase [overflow-wrap:anywhere]">
              {companyName}
            </p>
          )}
          <PageTitle title={t('title')} subheading={t('subheading')} />
        </div>
        <span className="mt-2 inline-flex shrink-0 items-center rounded-pill border border-border bg-card px-2.5 py-0.5 text-xs">
          {t('adminBadge')}
        </span>
      </div>
      <SettingsTabs>{children}</SettingsTabs>
    </>
  );
}
