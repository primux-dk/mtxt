import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/session';
import { tabHref } from '@/lib/settings/tabs';

/** The settings page opens on its first tab. */
export default async function SettingsPage() {
  await requireAdmin('/settings');
  redirect(tabHref('general'));
}
