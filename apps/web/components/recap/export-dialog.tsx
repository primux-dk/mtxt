'use client';

/*
  Export, the meeting page's one primary action (behaviour.md rule 10): a
  dialog offering the recap as Markdown (the stored body) or Word. Each
  choice is a download link to the export route, which checks access and
  writes the audit row. Disabled, with the reason, until there is a recap.
*/
import { Download, FileText, FileType } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export function ExportDialog({ meetingId, available }: { meetingId: string; available: boolean }) {
  const t = useTranslations('export');
  const tc = useTranslations('common');
  if (!available) {
    return (
      <span title={t('none')}>
        <Button
          variant="primary"
          disabled
          aria-describedby="export-none"
          className="max-shell:text-xs"
        >
          <Download aria-hidden="true" />
          {t('button')}
        </Button>
        <span id="export-none" className="sr-only">
          {t('none')}
        </span>
      </span>
    );
  }
  const option = (format: 'md' | 'docx', Icon: typeof FileText) => (
    <li>
      <a
        href={`/api/v1/meetings/${meetingId}/export?format=${format}`}
        download
        className="flex min-h-14 items-center gap-3 rounded-card border border-border px-4 py-3 hover:bg-secondary"
      >
        <Icon aria-hidden="true" className="size-5 shrink-0 text-accent-strong" strokeWidth={1.5} />
        <span className="grid">
          <span className="font-[550]">{t(`${format}.label`)}</span>
          <span className="text-xs text-muted-foreground">{t(`${format}.help`)}</span>
        </span>
      </a>
    </li>
  );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="primary" className="max-shell:text-xs">
          <Download aria-hidden="true" />
          {t('button')}
        </Button>
      </DialogTrigger>
      <DialogContent closeLabel={tc('close')}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <ul className="grid gap-2">
          {option('md', FileText)}
          {option('docx', FileType)}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
