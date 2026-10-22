'use client';

import * as React from 'react';
import { cn } from 'cn';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';

/*
  shadcn DropdownMenu (Radix): arrow keys move between items, Enter picks,
  Escape closes and returns focus to the trigger. Restyled to docs/design.
*/
const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuTrigger = MenuPrimitive.Trigger;

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-48 rounded-control border border-border bg-popover p-1 text-sm text-popover-foreground shadow-floating duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
          className,
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { tone?: 'destructive' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex min-h-10 cursor-pointer items-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-3 py-2 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-secondary max-shell:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]',
        tone === 'destructive' && 'text-destructive',
        className,
      )}
      {...props}
    />
  );
}

const DropdownMenuSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) => (
  <MenuPrimitive.Separator className={cn('my-1 h-px bg-line-subtle', className)} {...props} />
);

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
};
