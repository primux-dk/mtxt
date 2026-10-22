import { describe, expect, it } from 'vitest';
import { open, seal } from '../src/secrets';

const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe('seal and open', () => {
  it('round-trips a secret, including non-ASCII text', async () => {
    const k = key();
    const secret = 'client-secret~with.dots_and-ÆØÅ';
    const sealed = await seal(secret, k);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(secret);
    expect(await open(sealed, k)).toBe(secret);
  });

  it('uses a fresh IV per call', async () => {
    const k = key();
    expect(await seal('same', k)).not.toBe(await seal('same', k));
  });

  it('refuses a wrong key', async () => {
    const sealed = await seal('secret', key());
    await expect(open(sealed, key())).rejects.toThrow(/wrong SETTINGS_KEY/);
  });

  it('refuses a changed ciphertext', async () => {
    const k = key();
    const sealed = await seal('secret', k);
    const last = sealed.at(-1) === 'A' ? 'B' : 'A';
    await expect(open(sealed.slice(0, -1) + last, k)).rejects.toThrow();
  });

  it('refuses a value that was never sealed', async () => {
    await expect(open('plain-text-secret', key())).rejects.toThrow(/Not a sealed value/);
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(seal('secret', btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});
