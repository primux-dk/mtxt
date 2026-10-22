import { getTranslations } from 'next-intl/server';
import { BrowserRecorder } from '@/components/recorder/browser-recorder';
import { PageTitle } from '@/components/page-title';
import { getInstallSettings } from '@/lib/install';
import { pageUser } from '@/lib/page-user';

/** Record a meeting in the browser (capture route 2). */
export default async function NewMeetingPage() {
  const [, t, settings] = await Promise.all([
    pageUser(),
    getTranslations('recorder.web'),
    getInstallSettings(),
  ]);
  return (
    <div className="max-w-[640px]">
      <div className="mb-8 max-shell:mb-6">
        <PageTitle title={t('title')} subheading={t('subheading')} />
      </div>
      <BrowserRecorder
        enabled={settings.recordingSources.includes('browser')}
        canUpload={settings.recordingSources.includes('upload')}
      />
    </div>
  );
}
