/*
  Keys derived from SETTINGS_KEY for one use each: HMAC-SHA256 of a fixed
  label under the key, so a signature made for one use (a webhook's export
  link, an MCP client's id) never verifies for another.
*/

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

export const fromB64url = (text: string) => {
  const normal = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

export async function derivedKey(
  settingsKey: string,
  label: string,
  usage: 'sign' | 'verify',
): Promise<CryptoKey> {
  const raw = fromB64url(settingsKey.trim());
  if (raw.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes of base64.');
  const root = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const derived = await crypto.subtle.sign('HMAC', root, new TextEncoder().encode(label));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}
