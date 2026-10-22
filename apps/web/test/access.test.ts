import { describe, expect, it } from 'vitest';
import { resolveAccess } from '../lib/meetings/access';

const owner = { id: 'u-owner' };
const colleague = { id: 'u-colleague' };
const admin = { id: 'u-admin', isAdmin: true };
const meeting = (visibility: 'private' | 'shared' | 'company', deletedAt: Date | null = null) => ({
  ownerId: owner.id,
  visibility,
  deletedAt,
});

describe('resolveAccess', () => {
  it('gives the owner every meeting of theirs', () => {
    for (const v of ['private', 'shared', 'company'] as const) {
      expect(resolveAccess(meeting(v), owner, false)).toBe('owner');
    }
  });

  it('lets a colleague read a shared meeting only when named on it', () => {
    expect(resolveAccess(meeting('shared'), colleague, true)).toBe('reader');
    expect(resolveAccess(meeting('shared'), colleague, false)).toBeNull();
  });

  it('lets anyone in the install read a company meeting', () => {
    expect(resolveAccess(meeting('company'), colleague, false)).toBe('reader');
  });

  it('keeps a private meeting private, from an admin too', () => {
    expect(resolveAccess(meeting('private'), colleague, false)).toBeNull();
    expect(resolveAccess(meeting('private'), admin, false)).toBeNull();
    // A share row left over from when it was shared does not open it.
    expect(resolveAccess(meeting('private'), colleague, true)).toBeNull();
  });

  it('gives nobody a deleted meeting', () => {
    expect(resolveAccess(meeting('company', new Date()), owner, false)).toBeNull();
  });
});
