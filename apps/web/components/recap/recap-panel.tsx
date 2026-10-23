'use client';

/*
  The recap tab (figure 04): the panel head with the template and the
  versions, then the editor, or the state the recap is in (behaviour.md
  rules 8 and 9): being drafted, failed with Try again, or not yet written.
  A draft that lands while the page is open shows without a reload.
*/
import { useRef, useState, useTransition } from 'react';
import { FileText, History, Loader, RefreshCw, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from 'cn';
import { regenerateRecap, setRecapTemplate } from '@/app/(app)/meetings/recap-actions';
import { RefreshWhile } from '@/components/meeting/refresh-while';
import { Button } from '@/components/ui/button';
import type { VersionView } from '@/lib/recap/view';
import { RecapEditor } from './recap-editor';
import { VersionsDialog } from './versions-dialog';

export interface RecapPanelProps {
  meetingId: string;
  owner: boolean;
  recap: {
    id: string;
    status: 'drafting' | 'ready' | 'failed';
    /** The failure in the reader's language. */
    failure: string | null;
    /** A draft that has run this long without an answer may be started again. */
    stale: boolean;
  } | null;
  current: VersionView | null;
  bodyMd: string;
  lastAi: number | null;
  templates: { id: string; name: string }[];
  templateId: string | null;
  meetingDate: string;
  owners: (string | null)[];
  /** A transcript the recap can be drafted from. */
  canDraft: boolean;
}

function State({
  Icon,
  title,
  body,
  tone,
  children,
}: {
  Icon: typeof Loader;
  title: string;
  body: string;
  tone?: 'warning';
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'warning' ? 'alert' : 'status'}
      className="grid gap-3 px-5 py-10 text-center max-shell:px-4"
    >
      <Icon
        aria-hidden="true"
        strokeWidth={1.5}
        className={cn(
          'mx-auto size-7',
          tone === 'warning' ? 'text-destructive' : 'text-accent-strong',
        )}
      />
      <h2 className="text-xl">{title}</h2>
      <p className="text-sm text-muted-foreground">{body}</p>
      {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

function DraftButton({
  meetingId,
  label,
  variant = 'secondary',
  small,
  onStarted,
}: {
  meetingId: string;
  label: string;
  variant?: 'secondary' | 'quiet' | 'primary';
  /** The panel head's size, next to Versions. */
  small?: boolean;
  onStarted?: () => void;
}) {
  const t = useTranslations('recap');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <Button
        variant={variant}
        className={small ? 'text-xs [&_svg:not([class*=size-])]:size-4' : undefined}
        aria-busy={pending || undefined}
        onClick={() =>
          start(async () => {
            setFailed(null);
            const result = await regenerateRecap(meetingId).catch(() => ({
              ok: false as const,
              code: 'server' as const,
            }));
            if (!result.ok) {
              setFailed(
                result.code === 'no_transcript'
                  ? t('draft.noTranscript')
                  : t('draft.couldNotStart'),
              );
              return;
            }
            onStarted?.();
            router.refresh();
          })
        }
      >
        <RefreshCw aria-hidden="true" />
        {label}
      </Button>
      {failed && (
        <p role="alert" className="basis-full text-xs text-destructive">
          {failed}
        </p>
      )}
    </>
  );
}

function TemplateSelect({
  meetingId,
  templates,
  templateId,
}: {
  meetingId: string;
  templates: { id: string; name: string }[];
  templateId: string | null;
}) {
  const t = useTranslations('recap');
  const [value, setValue] = useState(templateId ?? '');
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        aria-label={t('template.label')}
        value={value}
        className="max-w-[190px] min-h-8 rounded-[6px] border border-input bg-card px-1.5 text-xs max-shell:min-h-11"
        onChange={async (e) => {
          const before = value;
          const next = e.target.value;
          // Optimistic, and back to the server's value if it refuses (rule 2).
          setValue(next);
          setFailed(false);
          const result = await setRecapTemplate(meetingId, next || null).catch(() => ({
            ok: false,
          }));
          if (!result.ok) {
            setValue(before);
            setFailed(true);
          }
        }}
      >
        <option value="">{t('template.default')}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id} lang="">
            {tpl.name}
          </option>
        ))}
      </select>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          {t('template.failed')}
        </span>
      )}
    </span>
  );
}

export function RecapPanel(props: RecapPanelProps) {
  const { meetingId, owner, recap } = props;
  const t = useTranslations('recap');
  const [versionsOpen, setVersionsOpen] = useState(false);
  // A version made in this window is not "new" to it; anything else remounts the editor.
  const known = useRef(new Set<string>(props.current ? [props.current.id] : []));
  const [mounted, setMounted] = useState(props.current?.id ?? 'none');
  const [lastAi, setLastAi] = useState(props.lastAi);
  if (props.current && !known.current.has(props.current.id) && mounted !== props.current.id) {
    known.current.add(props.current.id);
    setMounted(props.current.id);
    setLastAi(props.lastAi);
  }
  const adoptRef = useRef<((version: VersionView, bodyMd: string) => void) | null>(null);
  const versionsButton = useRef<HTMLButtonElement>(null);

  const drafting = recap?.status === 'drafting' && !recap.stale;

  if (!props.current) {
    if (drafting || (!recap && props.canDraft)) {
      return (
        <State Icon={Loader} title={t('draft.drafting')} body={t('draft.draftingBody')}>
          <RefreshWhile seconds={5} />
          {owner && !drafting && <DraftButton meetingId={meetingId} label={t('draft.start')} />}
        </State>
      );
    }
    if (recap && (recap.status === 'failed' || recap.stale)) {
      return (
        <State
          tone="warning"
          Icon={TriangleAlert}
          title={t('draft.failed')}
          body={recap.failure ?? t('draft.failedBody')}
        >
          {owner ? (
            <DraftButton meetingId={meetingId} label={t('draft.tryAgain')} />
          ) : (
            <p className="basis-full text-xs text-muted-foreground">{t('draft.askOwner')}</p>
          )}
        </State>
      );
    }
    return <State Icon={FileText} title={t('pending.title')} body={t('pending.body')} />;
  }

  const head = (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-5 py-3 max-shell:px-4">
      <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {owner && (
          <>
            <span aria-hidden="true">{t('template.heading')}</span>
            <TemplateSelect
              meetingId={meetingId}
              templates={props.templates}
              templateId={props.templateId}
            />
          </>
        )}
      </span>
      <span className="inline-flex flex-wrap items-center gap-1">
        <Button
          ref={versionsButton}
          variant="quiet"
          className="text-xs"
          aria-haspopup="dialog"
          onClick={() => setVersionsOpen(true)}
        >
          <History aria-hidden="true" className="size-4" />
          {t('versionsButton')}
        </Button>
        {owner && props.canDraft && !drafting && (
          <DraftButton meetingId={meetingId} label={t('draft.regenerate')} variant="quiet" small />
        )}
      </span>
    </div>
  );

  const notice = drafting ? (
    <p
      role="status"
      className="flex items-center gap-2 border-b border-line-subtle bg-accent-tint-soft px-5 py-2.5 text-xs max-shell:px-4"
    >
      <Loader aria-hidden="true" className="size-4 text-accent-strong" strokeWidth={1.5} />
      {t('draft.newVersion')}
      <RefreshWhile seconds={5} />
    </p>
  ) : recap?.status === 'failed' || recap?.stale ? (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 text-xs text-destructive max-shell:px-4"
    >
      <TriangleAlert aria-hidden="true" className="size-4" strokeWidth={1.5} />
      <span className="grow">
        {t('draft.newFailed', { reason: recap.failure ?? t('draft.failedBody') })}
      </span>
      {owner && <DraftButton meetingId={meetingId} label={t('draft.tryAgain')} variant="quiet" />}
    </div>
  ) : null;

  return (
    <>
      <RecapEditor
        key={mounted}
        meetingId={meetingId}
        recapId={recap!.id}
        owner={owner}
        current={props.current}
        bodyMd={props.bodyMd}
        lastAi={lastAi}
        meetingDate={props.meetingDate}
        owners={props.owners}
        head={head}
        notice={notice}
        onVersion={(version) => {
          known.current.add(version.id);
          if (version.author === null) setLastAi(version.number);
        }}
        registerAdopt={(adopt) => (adoptRef.current = adopt)}
      />
      <VersionsDialog
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        returnFocus={versionsButton}
        meetingId={meetingId}
        owner={owner}
        currentId={props.current.id}
        onRestored={(version, bodyMd) => {
          known.current.add(version.id);
          adoptRef.current?.(version, bodyMd);
        }}
      />
    </>
  );
}
