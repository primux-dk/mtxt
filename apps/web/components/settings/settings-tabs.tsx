'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { SETTINGS_TABS, tabHref, tabOf, type SettingsTab } from '@/lib/settings/tabs';
import { useUnsavedGuard } from './unsaved-guard';

const tabId = (tab: SettingsTab) => `settings-tab-${tab}`;
const PANEL_ID = 'settings-panel';

/**
 * The settings page's tab strip, one route per tab (docs/spec.md "Settings
 * page"). Each tab is a link with role="tab", so it opens in a new tab or
 * window like any link. The keyboard pattern is the meeting page's: the
 * selected tab is the one tab stop, arrows move focus, Home and End jump,
 * Enter or Space opens the focused tab (manual activation: opening one is a
 * navigation), Tab moves into the panel. A tab with unsaved changes has a
 * dot, and leaving it asks first (UnsavedGuard). On a phone the strip
 * scrolls sideways and keeps the selected tab in view.
 */
export function SettingsTabs({ children }: { children: React.ReactNode }) {
  const t = useTranslations('settings.tabs');
  const current = tabOf(usePathname());
  const guard = useUnsavedGuard();
  const listRef = useRef<HTMLDivElement>(null);

  const { setPlace } = guard;
  useEffect(() => {
    setPlace(current && t(current));
    return () => setPlace(null);
  }, [current, setPlace, t]);

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

  // Without scroll: false the router would move focus to the new tab's content; it stays on the tab.
  const open = (tab: SettingsTab, opener: HTMLElement) => {
    if (tab === current) return;
    guard.navigate(tabHref(tab), { scroll: false, destination: t(tab), opener });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLAnchorElement>, index: number) => {
    const last = SETTINGS_TABS.length - 1;
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = SETTINGS_TABS[(to + SETTINGS_TABS.length) % SETTINGS_TABS.length]!;
      document.getElementById(tabId(next))?.focus();
    } else if (e.key === ' ') {
      // Enter is the link's own click; Space opens the tab as on a button.
      e.preventDefault();
      open(SETTINGS_TABS[index]!, e.currentTarget);
    }
  };

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>, tab: SettingsTab) => {
    // A new tab or window opens as any link does; the changes here stay.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open(tab, e.currentTarget);
  };

  return (
    <>
      {/* The baseline is a shadow, not a border: the strip scrolls, and a scroller clips a tab's underline laid over its border. */}
      <div
        ref={listRef}
        role="tablist"
        aria-label={t('label')}
        className="mb-6 flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] max-shell:-mx-5 max-shell:mb-5 max-shell:px-5"
      >
        {SETTINGS_TABS.map((tab, index) => {
          const selected = tab === current;
          return (
            <a
              key={tab}
              id={tabId(tab)}
              href={tabHref(tab)}
              role="tab"
              aria-selected={selected}
              aria-controls={selected ? PANEL_ID : undefined}
              // The selected tab is the strip's one tab stop; with none selected, the first.
              tabIndex={selected || (!current && index === 0) ? 0 : -1}
              onClick={(e) => onClick(e, tab)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className="inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3.5 py-2.5 text-sm whitespace-nowrap text-muted-foreground outline-offset-[-2px] transition-[color,border-color] hover:text-foreground aria-selected:border-accent-strong aria-selected:text-foreground max-shell:px-3"
            >
              {t(tab)}
              {guard.dirty && selected && (
                <>
                  <span
                    className="size-1.5 rounded-full bg-accent-strong"
                    data-testid="unsaved-dot"
                    aria-hidden="true"
                  />
                  <span className="sr-only">{t('unsavedLabel')}</span>
                </>
              )}
            </a>
          );
        })}
      </div>
      {current ? (
        <div
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(current)}
          tabIndex={0}
          className="min-w-0"
        >
          {children}
        </div>
      ) : (
        children
      )}
    </>
  );
}
