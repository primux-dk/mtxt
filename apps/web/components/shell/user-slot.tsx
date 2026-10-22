import { LogOut } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth';

export interface ShellUser {
  name: string;
  email: string;
}

/** Up to two initials from the name; the avatar is decorative, the name is beside it. */
const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toLocaleUpperCase())
    .join('');

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

export function Avatar({ name }: { name?: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-line-strong bg-accent-tint text-xs font-[550] text-accent-foreground"
    >
      {name ? initials(name) : null}
    </span>
  );
}
