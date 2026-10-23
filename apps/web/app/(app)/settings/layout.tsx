import { SettingsNav } from '@/components/settings/settings-nav';

/** Both admin pages share the switch between them; each page checks admin itself. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SettingsNav />
      {children}
    </>
  );
}
