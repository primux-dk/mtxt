'use client';

import { Menu } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { NavItems } from './nav-items';

/** Below 720 px the sidebar becomes this Sheet, opened from the top bar. */
export function MobileNav({
  productName,
  companyName,
}: {
  productName: string;
  companyName?: string | null;
}) {
  const t = useTranslations('nav');
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="quiet" size="icon" aria-label={t('open')}>
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" closeLabel={t('close')} className="gap-6 rounded-r-panel p-6">
        <div className="pr-12">
          <SheetTitle className="text-base leading-[1.3] tracking-[-0.03em]">
            {productName}
          </SheetTitle>
          {companyName && <p className="mt-1 text-xs text-muted-foreground">{companyName}</p>}
        </div>
        <SheetDescription className="sr-only">{t('mobile.description')}</SheetDescription>
        <NavItems label={t('mobile.label')} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
