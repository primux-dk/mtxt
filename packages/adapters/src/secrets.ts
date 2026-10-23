/**
 * Secrets at rest: provider credentials stored in the settings row are sealed
 * with AES-GCM under the Worker secret SETTINGS_KEY (32 bytes, base64).
 *
 * A sealed value is `v1.<iv>.<ciphertext>`, both parts base64url. The version
 * prefix leaves room to rotate the scheme without guessing at old rows.
 *
 * Each value is bound to its context (the column it lives in) as AES-GCM
 * additional data, `mtxt:<context>:v1`. A value copied into another column
 * does not open there.
 * WebCrypto only, so the same code runs in Workers, Node and a Docker edition.
 */

const VERSION = 'v1';
const IV_BYTES = 12;

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const normal = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function importKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(keyBase64.trim());
  } catch {
    throw new Error('SETTINGS_KEY is not valid base64.');
  }
  if (raw.length !== 32) {
    throw new Error(`SETTINGS_KEY must be 32 bytes of base64; it is ${raw.length} bytes.`);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Where a sealed value may live. */
export type SecretContext =
  | 'settings.oidc_client_secret'
  | 'settings.stt_api_key'
  | 'settings.webhook_secret'
  | 'settings.recap_api_key';

const additionalData = (context: SecretContext) =>
  new TextEncoder().encode(`mtxt:${context}:${VERSION}`);

/** Encrypts a secret for storage. Each call uses a fresh IV, so equal inputs give different outputs. */
export async function seal(
  plaintext: string,
  context: SecretContext,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(context) },
      key,
      data,
    ),
  );
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

/** Decrypts a value from `seal`. Throws on a wrong key or context, a changed value or an unknown format. */
export async function open(
  sealed: string,
  context: SecretContext,
  keyBase64: string,
): Promise<string> {
  const [version, iv, ciphertext, ...rest] = sealed.split('.');
  if (version !== VERSION || !iv || !ciphertext || rest.length) {
    throw new Error('Not a sealed value.');
  }
  const key = await importKey(keyBase64);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv), additionalData: additionalData(context) },
      key,
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(
      'Could not open the sealed value: wrong SETTINGS_KEY, wrong context or a changed value.',
    );
  }
}
