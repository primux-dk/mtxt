import { Suspense } from 'react';
import { getTranslations } from 'next-intl/server';
import { MobileNav } from './mobile-nav';
import { NavItems } from './nav-items';
import { Avatar, UserSlot, type ShellUser } from './user-slot';

/**
 * The app shell from the mockups: a 224 px sidebar with the product name, the
 * three navigation items and the user, whose menu holds Settings for an
 * admin; below 720 px a 56 px top bar and a Sheet.
 */
export async function AppShell({
  productName,
  companyName,
  user,
  children,
}: {
  productName: string;
  /** Optional: the line is left out when the install has not set it. */
  companyName?: string | null;
  user: ShellUser;
  children: React.ReactNode;
}) {
  const t = await getTranslations('nav');

  return (
    <div className="min-h-dvh shell:grid shell:grid-cols-[224px_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-dvh flex-col gap-7 border-r border-sidebar-border bg-sidebar px-4 pt-7 pb-5 max-shell:hidden">
        <div>
          <div className="text-base leading-[1.3] font-[650] tracking-[-0.03em] [overflow-wrap:anywhere]">
            {productName}
          </div>
          {companyName && <div className="mt-1 text-xs text-muted-foreground">{companyName}</div>}
        </div>
        <Suspense>
          <NavItems label={t('main.label')} />
        </Suspense>
        <div className="mt-auto border-t border-sidebar-border pt-6">
          <UserSlot user={user} companyName={companyName} />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="flex min-h-14 items-center justify-between border-b border-border bg-card px-3 py-1.5 shell:hidden">
          <Suspense>
            <MobileNav productName={productName} companyName={companyName}>
              <UserSlot user={user} companyName={companyName} />
            </MobileNav>
          </Suspense>
          <span className="min-w-0 truncate px-2 text-sm leading-[1.3] font-[650] tracking-[-0.03em]">
            {productName}
          </span>
          <Avatar name={user.name} />
        </header>
        <main className="min-w-0 p-8 max-shell:px-5 max-shell:py-6">{children}</main>
      </div>
    </div>
  );
}
