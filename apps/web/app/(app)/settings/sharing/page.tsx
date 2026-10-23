import { SharingForm } from '@/components/settings/sharing-form';
import { requireAdmin } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';

/** The Sharing and retention tab. Admins only. */
export default async function SharingSettingsPage() {
  await requireAdmin('/settings/sharing');
  const settings = await getInstallSettings();
  return (
    <SharingForm
      values={{
        defaultVisibility: settings.defaultVisibility,
        recordingSources: [...settings.recordingSources],
        retentionAudioDays: settings.retentionAudioDays,
        retentionTranscriptDays: settings.retentionTranscriptDays,
        mcpEnabled: settings.mcpEnabled,
        webhookAutoSend: settings.webhookAutoSend,
      }}
    />
  );
}
