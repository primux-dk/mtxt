import { UnconfirmedAudioGuard } from '@/components/recorder/unconfirmed-audio-guard';
import { UnsavedGuard } from '@/components/settings/unsaved-guard';
import { AppShell } from '@/components/shell/app-shell';
import { requireUser } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, { productName, companyName }] = await Promise.all([
    requireUser(),
    getInstallSettings(),
  ]);
  return (
    // Around the shell: the sidebar and the user menu ask before a settings tab's changes are lost.
    <UnsavedGuard>
      <AppShell productName={productName} companyName={companyName} user={user}>
        <UnconfirmedAudioGuard />
        {children}
      </AppShell>
    </UnsavedGuard>
  );
}
