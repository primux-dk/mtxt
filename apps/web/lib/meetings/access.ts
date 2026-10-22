import type { Visibility } from '@mtxt/adapters';

/** What a user may do with a meeting. */
export type Access = 'owner' | 'reader' | null;

/**
 * The permission resolver (docs/spec.md "Private and shared"). The owner
 * does everything; a colleague reads a `company` meeting, or a `shared` one
 * they are named on. Being an admin changes nothing: private means private,
 * and an admin sees a private meeting's metadata only through the audit log.
 * A deleted meeting is nobody's.
 */
export function resolveAccess(
  meeting: { ownerId: string; visibility: Visibility; deletedAt?: Date | null },
  user: { id: string; isAdmin?: boolean },
  isSharedWithUser: boolean,
): Access {
  if (meeting.deletedAt) return null;
  if (meeting.ownerId === user.id) return 'owner';
  if (meeting.visibility === 'company') return 'reader';
  if (meeting.visibility === 'shared' && isSharedWithUser) return 'reader';
  return null;
}
