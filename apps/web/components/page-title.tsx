import { cn } from 'cn';

/**
 * The page heading block every screen uses: title, optional subheading, one
 * primary action. Level 2 is for a page inside a tab of another page, such
 * as the audit log under the settings page's title.
 */
export function PageTitle({
  title,
  subheading,
  action,
  level = 1,
}: {
  title: string;
  subheading?: string;
  action?: React.ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-4">
      <div className="min-w-0">
        <Heading
          className={cn(
            level === 1
              ? 'text-[32px] leading-[1.15] tracking-[-0.04em] max-shell:text-2xl max-shell:leading-[1.2] max-shell:tracking-[-0.03em]'
              : 'text-xl leading-[1.3] tracking-[-0.03em]',
          )}
        >
          {title}
        </Heading>
        {subheading && <p className="mt-2 text-sm text-muted-foreground">{subheading}</p>}
      </div>
      {action}
    </div>
  );
}
