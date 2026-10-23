'use client';

import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { SETTINGS_TABS, tabHref, tabOf, type SettingsTab } from '@/lib/settings/tabs';

/** A tab's form reports here whether it holds changes that are not saved. */
const UnsavedContext = createContext<(dirty: boolean) => void>(() => {});
export const useReportUnsaved = () => useContext(UnsavedContext);

/**
 * The settings page's tab strip, one route per tab (docs/spec.md "Settings
 * page"). Radix gives the meeting page's keyboard pattern: arrows move
 * between tabs, Home and End jump, Enter or Space opens one, Tab moves into
 * the panel. Activation is manual because opening a tab is a navigation.
 * A tab with unsaved changes has a dot; leaving it asks first. On a phone
 * the strip scrolls sideways and keeps the selected tab in view.
 */
export function SettingsTabs({ children }: { children: React.ReactNode }) {
  const t = useTranslations('settings.tabs');
  const tc = useTranslations('common');
  const router = useRouter();
  const current = tabOf(usePathname());
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<SettingsTab | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    // Sideways only: scrollIntoView would move the page as well.
    const left = selected.offsetLeft - list.offsetLeft;
    if (
      left < list.scrollLeft ||
      left + selected.offsetWidth > list.scrollLeft + list.clientWidth
    ) {
      list.scrollLeft = left - (list.clientWidth - selected.offsetWidth) / 2;
    }
  }, [current]);

  const open = (tab: string) => {
    const next = tab as SettingsTab;
    if (next === current) return;
    if (dirty) setLeaving(next);
    else router.push(tabHref(next));
  };

  return (
    <UnsavedContext.Provider value={setDirty}>
      <TabsPrimitive.Root value={current ?? ''} onValueChange={open} activationMode="manual">
        <TabsPrimitive.List
          ref={listRef}
          aria-label={t('label')}
          className="mb-6 flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] max-shell:-mx-5 max-shell:mb-5 max-shell:px-5"
        >
          {SETTINGS_TABS.map((tab) => (
            <TabsPrimitive.Trigger
              key={tab}
              value={tab}
              className="-mb-px inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3.5 py-2.5 text-sm whitespace-nowrap text-muted-foreground transition-[color,border-color] hover:text-foreground data-[state=active]:border-accent-strong data-[state=active]:text-foreground max-shell:px-3"
            >
              {t(tab)}
              {dirty && tab === current && (
                <span
                  className="size-1.5 rounded-full bg-accent-strong"
                  data-testid="unsaved-dot"
                  aria-hidden="true"
                />
              )}
              {dirty && tab === current && <span className="sr-only">{t('unsavedLabel')}</span>}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        {current ? (
          <TabsPrimitive.Content value={current} className="min-w-0 outline-none">
            {children}
          </TabsPrimitive.Content>
        ) : (
          children
        )}
      </TabsPrimitive.Root>

      <Dialog open={leaving !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent closeLabel={tc('close')}>
          <DialogTitle>{t('discard.title')}</DialogTitle>
          <DialogDescription>
            {current && leaving && t('discard.body', { tab: t(current), next: t(leaving) })}
          </DialogDescription>
          <DialogFooter>
            <DialogClose asChild>
              <Button>{t('discard.keep')}</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const next = leaving!;
                setLeaving(null);
                setDirty(false);
                router.push(tabHref(next));
              }}
            >
              {t('discard.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UnsavedContext.Provider>
  );
}
