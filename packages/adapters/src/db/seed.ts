import { DEFAULT_SETTINGS } from './defaults.ts';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * SQL that writes the default settings row for an install. Idempotent: a row
 * that exists is left alone, so seeding never undoes an admin's changes.
 */
export function seedSql(installId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(installId)) {
    throw new Error(`Install id must be 1-64 letters, digits, _ or -: ${installId}`);
  }
  const s = DEFAULT_SETTINGS;
  const columns: [string, string | number | boolean | null][] = [
    ['install_id', installId],
    ['product_name', s.productName],
    ['company_name', s.companyName],
    ['theme_accent', s.themeAccent],
    ['theme_primary', s.themePrimary],
    ['identity_provider', s.identityProvider],
    ['stt_provider', s.sttProvider],
    ['language', s.language],
    ['interface_language', s.interfaceLanguage],
    ['live_transcript_default', s.liveTranscriptDefault],
    ['default_visibility', s.defaultVisibility],
    ['retention_audio_days', s.retentionAudioDays],
    ['retention_transcript_days', s.retentionTranscriptDays],
    ['mcp_enabled', s.mcpEnabled],
    ['recording_sources', JSON.stringify(s.recordingSources)],
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
