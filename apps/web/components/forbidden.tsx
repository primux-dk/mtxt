import { Lock } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Button } from '@/components/ui/button';

/** 403: what a signed-in user who is not an admin sees on /settings. Not a redirect to login. */
export async function Forbidden() {
  const t = await getTranslations('auth.forbidden');
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="grid max-w-[400px] justify-items-start gap-4 rounded-panel border border-border bg-card p-10 max-shell:p-6">
        <Lock aria-hidden="true" className="size-5 text-muted-foreground" strokeWidth={1.5} />
        <h1 className="text-2xl tracking-[-0.03em]">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        <Button asChild>
          <Link href="/meetings">{t('back')}</Link>
        </Button>
      </div>
    </main>
  );
}
