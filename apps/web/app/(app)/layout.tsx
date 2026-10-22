import { AppShell } from '@/components/shell/app-shell';
import { getInstallSettings } from '@/lib/install';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { productName, companyName } = await getInstallSettings();
  return (
    <AppShell productName={productName} companyName={companyName}>
      {children}
    </AppShell>
  );
}
