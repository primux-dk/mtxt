'use client';

import { Building2, CalendarDays, Settings, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';

const ITEMS = [
  { key: 'myMeetings', href: '/meetings', path: '/meetings', view: null, Icon: CalendarDays },
  {
    key: 'sharedWithMe',
    href: '/meetings?view=shared',
    path: '/meetings',
    view: 'shared',
    Icon: Users,
  },
  {
    key: 'wholeCompany',
    href: '/meetings?view=company',
    path: '/meetings',
    view: 'company',
    Icon: Building2,
  },
  { key: 'settings', href: '/settings', path: '/settings', view: null, Icon: Settings },
] as const;

/** The four navigation items, shared by the sidebar and the mobile Sheet. */
export function NavItems({ label, onNavigate }: { label: string; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const view = useSearchParams().get('view');

  return (
    <nav aria-label={label} className="grid gap-1">
      {ITEMS.map(({ key, href, path, view: itemView, Icon }) => {
        // Settings covers its sub-pages (/settings/audit); the library items differ by view.
        const current =
          path === '/settings'
            ? pathname === path || pathname.startsWith(`${path}/`)
            : pathname === path && view === itemView;
        return (
          <Link
            key={key}
            href={href}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex min-h-11 items-center gap-3 rounded-control px-3 py-2.5 text-sm text-sidebar-foreground transition-[background-color,color] hover:text-accent-strong',
              current && 'bg-sidebar-accent font-[550] text-sidebar-accent-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-[18px] shrink-0" strokeWidth={1.5} />
            <span>{t(key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
