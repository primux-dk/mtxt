/** The page heading block every screen uses: title, optional subheading, one primary action. */
export function PageTitle({
  title,
  subheading,
  action,
}: {
  title: string;
  subheading?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[32px] leading-[1.15] tracking-[-0.04em] max-shell:text-2xl max-shell:leading-[1.2] max-shell:tracking-[-0.03em]">
          {title}
        </h1>
        {subheading && <p className="mt-2 text-sm text-muted-foreground">{subheading}</p>}
      </div>
      {action}
    </div>
  );
}
