'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';

const ITEMS = [
  { key: 'settings', href: '/settings' },
  { key: 'audit', href: '/settings/audit' },
] as const;

/** The admin surface's two pages: the settings and the audit log (docs/spec.md "Settings page"). */
export function SettingsNav() {
  const t = useTranslations('audit.nav');
  const pathname = usePathname();
  return (
    <nav aria-label={t('label')} className="mb-6 flex flex-wrap gap-2">
      {ITEMS.map(({ key, href }) => {
        const current = pathname === href;
        return (
          <Link
            key={key}
            href={href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-9 items-center rounded-pill border border-border bg-card px-3.5 text-sm hover:bg-secondary max-shell:min-h-11',
              current &&
                'border-accent-line-control bg-accent-tint text-accent-foreground hover:bg-accent-tint',
            )}
          >
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );
}
