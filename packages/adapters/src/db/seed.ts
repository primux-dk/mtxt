import { DEFAULT_SETTINGS } from './defaults.ts';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** What a deploy may set on a new install's row instead of the defaults (deploy/install.mjs). */
export interface SeedOverrides {
  productName?: string;
  companyName?: string | null;
  language?: string;
  interfaceLanguage?: 'en' | 'da';
  /** IANA name; the app refuses one the runtime does not know at the settings page. */
  timeZone?: string;
  aiGatewayId?: string | null;
}

/**
 * SQL that writes the default settings row for an install. Idempotent: a row
 * that exists is left alone, so seeding never undoes an admin's changes. The
 * overrides apply only to the row this writes, never to one that exists.
 */
export function seedSql(installId: string, overrides: SeedOverrides = {}): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installId)) {
    throw new Error(`Install id must be 1-64 letters, digits, _ or -: ${installId}`);
  }
  const given = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const s = { ...DEFAULT_SETTINGS, ...given };
  const columns: [string, string | number | boolean | null][] = [
    ['install_id', installId],
    ['product_name', s.productName],
    ['company_name', s.companyName],
    ['theme_accent', s.themeAccent],
    ['theme_primary', s.themePrimary],
    ['identity_provider', s.identityProvider],
    ['oidc_tenant_id', s.oidcTenantId],
    ['oidc_client_id', s.oidcClientId],
    ['oidc_client_secret', s.oidcClientSecret],
    ['stt_provider', s.sttProvider],
    ['stt_api_key', s.sttApiKey],
    ['stt_region', s.sttRegion],
    ['ai_gateway_id', s.aiGatewayId],
    ['language', s.language],
    ['interface_language', s.interfaceLanguage],
    ['time_zone', s.timeZone],
    ['live_transcript_default', s.liveTranscriptDefault],
    ['default_visibility', s.defaultVisibility],
    ['retention_audio_days', s.retentionAudioDays],
    ['retention_transcript_days', s.retentionTranscriptDays],
    ['mcp_enabled', s.mcpEnabled],
    ['recording_sources', JSON.stringify(s.recordingSources)],
    ['admin_emails', JSON.stringify(s.adminEmails)],
    ['admin_bootstrap_claimed_at', s.adminBootstrapClaimedAt],
  ];
  const values = columns.map(([, v]) =>
    v === null ? 'NULL' : typeof v === 'string' ? quote(v) : Number(v),
  );
  return (
    `INSERT INTO settings (${columns.map(([c]) => c).join(', ')})\n` +
    `VALUES (${values.join(', ')})\n` +
    `ON CONFLICT (install_id) DO NOTHING;\n`
  );
}
