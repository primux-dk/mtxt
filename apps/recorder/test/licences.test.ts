import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script without types
import { verdict } from '../scripts/check-crate-licenses.mjs';

const hasCargo = spawnSync('cargo', ['--version']).status === 0;

describe('crate licences', () => {
  it('judges licences and names exceptions per crate', () => {
    expect(verdict('serde', 'MIT OR Apache-2.0')).toBe('ok');
    expect(verdict('ring', 'Apache-2.0 AND ISC')).toBe('ok');
    expect(verdict('cssparser', 'MPL-2.0')).toBe('excepted');
    expect(verdict('some-other-crate', 'MPL-2.0')).toBe('refused');
    expect(verdict('x', 'GPL-3.0-only')).toBe('refused');
    expect(verdict('x', 'LGPL-2.1-or-later OR MIT')).toBe('ok');
    expect(verdict('x', undefined)).toBe('refused');
  });

  it.skipIf(!hasCargo)(
    'NOTICE.md lists every shipped crate, current with cargo metadata',
    () => {
      const script = fileURLToPath(new URL('../scripts/check-crate-licenses.mjs', import.meta.url));
      // Exits non-zero when a licence is refused or the inventory is stale.
      expect(() => execFileSync('node', [script], { stdio: 'pipe' })).not.toThrow();
    },
    120_000,
  );
});
