import { SharingForm } from '@/components/settings/sharing-form';
import { requireAdmin } from '@/lib/auth/session';
import { getInstallSettings } from '@/lib/install';
import { pageOrigin } from '@/lib/mcp/http';
import { MCP_PATH } from '@/lib/mcp/oauth';

/** The Sharing and retention tab. Admins only. */
export default async function SharingSettingsPage() {
  await requireAdmin('/settings/sharing');
  const [settings, origin] = await Promise.all([getInstallSettings(), pageOrigin()]);
  return (
    <SharingForm
      mcpUrl={`${origin}${MCP_PATH}`}
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
