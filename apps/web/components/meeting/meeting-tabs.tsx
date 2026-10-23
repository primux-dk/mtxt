'use client';

import { Tabs as TabsPrimitive } from 'radix-ui';

/**
 * Recap and Transcript as two tabs, one panel at a time at full width
 * (docs/decisions.md). Radix gives the full keyboard tab pattern: arrows,
 * Home and End, Tab into the panel.
 */
export function MeetingTabs({
  label,
  initial,
  tabs,
}: {
  label: string;
  initial: 'recap' | 'transcript';
  tabs: { value: 'recap' | 'transcript'; label: string; count?: string; panel: React.ReactNode }[];
}) {
  return (
    <TabsPrimitive.Root defaultValue={initial}>
      <TabsPrimitive.List
        aria-label={label}
        className="mb-6 flex gap-1 border-b border-border max-shell:mb-5"
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className="-mb-px min-h-11 border-b-2 border-transparent px-3.5 py-2.5 text-sm text-muted-foreground transition-[color,border-color] hover:text-foreground data-[state=active]:border-accent-strong data-[state=active]:text-foreground max-shell:px-3"
          >
            {tab.label}
            {tab.count && <span className="ml-2 text-text-muted tabular-nums">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content
          key={tab.value}
          value={tab.value}
          className="min-w-0 overflow-clip rounded-card border border-border bg-card"
        >
          {tab.panel}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
