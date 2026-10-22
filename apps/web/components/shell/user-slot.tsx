import { UserRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

/** The signed-in user. Empty until the company login lands (packet 2). */
export async function UserSlot() {
  const t = await getTranslations('nav');
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <Avatar />
      <span className="text-muted-foreground">{t('signedOut')}</span>
    </div>
  );
}

export function Avatar() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-line-strong bg-accent-tint text-accent-foreground"
    >
      <UserRound className="size-4" strokeWidth={1.5} />
    </span>
  );
}
