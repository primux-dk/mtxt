'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useUnsavedGuard } from '@/components/settings/unsaved-guard';
import { NavItems } from './nav-items';

/** Below 720 px the sidebar becomes this Sheet, opened from the top bar. */
export function MobileNav({
  productName,
  companyName,
  children,
}: {
  productName: string;
  companyName?: string | null;
  /** The signed-in user and "Sign out", rendered on the server. */
  children?: React.ReactNode;
}) {
  const t = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const guard = useUnsavedGuard();
  // A link from the user menu (Settings) navigates without the Sheet's own items.
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="quiet" size="icon" aria-label={t('open')}>
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        closeLabel={t('close')}
        className="gap-6 rounded-r-panel p-6"
        // A followed link closes the Sheet, also one to the page already open (Settings on
        // /settings/general), where the path does not change. The user menu is a portal, but
        // React events still bubble here. With unsaved settings the link asks first instead.
        onClick={(e) => {
          const link = (e.target as Element).closest?.('a[href]');
          const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
          if (link && plain && !guard.dirty) setOpen(false);
        }}
      >
        <div className="pr-12">
          <SheetTitle className="text-base leading-[1.3] tracking-[-0.03em] [overflow-wrap:anywhere]">
            {productName}
          </SheetTitle>
          {companyName && <p className="mt-1 text-xs text-muted-foreground">{companyName}</p>}
        </div>
        <SheetDescription className="sr-only">{t('mobile.description')}</SheetDescription>
        <NavItems label={t('mobile.label')} onNavigate={() => setOpen(false)} />
        {children && <div className="mt-auto border-t border-sidebar-border pt-6">{children}</div>}
      </SheetContent>
    </Sheet>
  );
}
