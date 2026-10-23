import { signOut } from '@/lib/auth';
import { Avatar } from '@/components/ui/avatar';
import { UserMenu } from './user-menu';

export { Avatar };

export interface ShellUser {
  name: string;
  email: string;
}

async function signOutAction() {
  'use server';
  await signOut({ redirectTo: '/login' });
}

/** The signed-in user: one row with the name and the company line, opening Recorders and Sign out. */
export function UserSlot({ user, companyName }: { user: ShellUser; companyName?: string | null }) {
  return <UserMenu user={{ name: user.name }} companyName={companyName} signOut={signOutAction} />;
}
