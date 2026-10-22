import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

/*
  shadcn Button, restyled to docs/design: a dark pill for the one primary
  action per screen, a bordered secondary for everything else, and a quiet
  text button. 40 px controls on desktop, 44 px touch targets below 720 px.
  State changes fade in 150 ms; nothing moves.
*/
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 border text-sm font-[550] whitespace-nowrap select-none transition-[background-color,color,border-color] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5 [&_svg]:stroke-[1.5]",
  {
    variants: {
      variant: {
        primary:
          'rounded-pill border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover',
        secondary:
          'rounded-control border-input bg-card text-foreground hover:border-text-muted hover:bg-secondary',
        quiet: 'rounded-control border-transparent bg-transparent hover:bg-secondary',
      },
      size: {
        default: 'min-h-10 px-4 py-2 max-shell:min-h-11',
        icon: 'size-10 p-2 max-shell:size-11',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={asChild ? undefined : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
