import { afterEach, describe, expect, it, vi } from 'vitest';

// The module imports server-side packages; only its top-level guard matters here.
vi.mock('next-auth/jwt', () => ({ encode: vi.fn() }));
vi.mock('@mtxt/adapters', () => ({}));
vi.mock('../lib/install', () => ({}));

describe('the e2e test sign-in', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('throws on import in a production bundle', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MTXT_E2E_BUILD', '');
    await expect(import('../lib/auth/test-sign-in')).rejects.toThrow(/production bundle/);
  });

  it('loads in an e2e build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MTXT_E2E_BUILD', '1');
    await expect(import('../lib/auth/test-sign-in')).resolves.toHaveProperty('testSignIn');
  });

  it('is not a route in a normal build', async () => {
    const { pageExtensions } = await import('../next-page-extensions');
    expect(pageExtensions(undefined)).not.toContain('e2e.ts');
    expect(pageExtensions('1')).toContain('e2e.ts');
  });
});
