import { LogOut } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth';
import { Avatar } from '@/components/ui/avatar';

export { Avatar };

export interface ShellUser {
  name: string;
  email: string;
}

async function signOutAction() {
  'use server';
  await signOut({ redirectTo: '/login' });
}

/** The signed-in user: name, the company line and "Sign out". */
export async function UserSlot({
  user,
  companyName,
}: {
  user: ShellUser;
  companyName?: string | null;
}) {
  const t = await getTranslations('auth');
  return (
    <div className="grid gap-3 text-[13px]">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={user.name} />
        <div className="min-w-0">
          <div className="truncate font-[550]" title={user.name}>
            {user.name}
          </div>
          {companyName && (
            <div className="truncate text-xs text-muted-foreground" title={companyName}>
              {companyName}
            </div>
          )}
        </div>
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="quiet" className="w-full justify-start px-2">
          <LogOut aria-hidden="true" />
          {t('signOut')}
        </Button>
      </form>
    </div>
  );
}
