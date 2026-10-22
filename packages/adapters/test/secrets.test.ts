import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/secrets';

const C = 'settings.oidc_client_secret' as const;
const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe('seal and open', () => {
  it('round-trips a secret, including non-ASCII text', async () => {
    const k = key();
    const secret = 'client-secret~with.dots_and-ÆØÅ';
    const sealed = await seal(secret, C, k);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(secret);
    expect(await open(sealed, C, k)).toBe(secret);
  });

  it('uses a fresh IV per call', async () => {
    const k = key();
    expect(await seal('same', C, k)).not.toBe(await seal('same', C, k));
  });

  it('refuses a wrong key', async () => {
    const sealed = await seal('secret', C, key());
    await expect(open(sealed, C, key())).rejects.toThrow(/wrong SETTINGS_KEY/);
  });

  it('refuses a changed ciphertext', async () => {
    const k = key();
    const sealed = await seal('secret', C, k);
    // Flip a character inside the ciphertext; the last one can carry only padding bits.
    const at = sealed.lastIndexOf('.') + 4;
    const flipped = sealed[at] === 'A' ? 'B' : 'A';
    await expect(
      open(sealed.slice(0, at) + flipped + sealed.slice(at + 1), C, k),
    ).rejects.toThrow();
  });

  it('refuses the right key with the wrong context', async () => {
    const k = key();
    const sealed = await seal('secret', 'settings.oidc_client_secret', k);
    await expect(open(sealed, 'settings.stt_api_key', k)).rejects.toThrow(/wrong context/);
    expect(await open(sealed, 'settings.oidc_client_secret', k)).toBe('secret');
  });

  it('refuses a value that was never sealed', async () => {
    await expect(open('plain-text-secret', C, key())).rejects.toThrow(/Not a sealed value/);
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(seal('secret', C, btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});
