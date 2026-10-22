import * as React from 'react';
import { cn } from 'cn';

/* shadcn Input, restyled to docs/design: 40 px, card fill, 1 px input border. */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'min-h-10 w-full min-w-0 rounded-control border border-input bg-card px-3 py-2 text-sm transition-[border-color] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive max-shell:min-h-11',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
