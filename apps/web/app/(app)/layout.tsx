import { UnconfirmedAudioGuard } from '@/components/recorder/unconfirmed-audio-guard';
import { AppShell } from '@/components/shell/app-shell';
import { requireUser } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, { productName, companyName }] = await Promise.all([
    requireUser(),
    getInstallSettings(),
  ]);
  return (
    <AppShell productName={productName} companyName={companyName} user={user}>
      <UnconfirmedAudioGuard />
      {children}
    </AppShell>
  );
}
