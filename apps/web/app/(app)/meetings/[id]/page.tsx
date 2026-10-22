import { Download, FileText, Loader, Lock, TriangleAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cn } from 'cn';
import type { Recording } from '@mtxt/adapters';
import { AudioPlayer } from '@/components/meeting/audio-player';
import { BackLink } from '@/components/meeting/back-link';
import { KeepToggle } from '@/components/meeting/keep-toggle';
import { ArchivedNotice, MeetingMenu } from '@/components/meeting/meeting-menu';
import { MeetingTabs } from '@/components/meeting/meeting-tabs';
import { MeetingTitle } from '@/components/meeting/meeting-title';
import { MakePrimary, RetryTranscription } from '@/components/meeting/recording-actions';
import { LocalTime } from '@/components/local-time';
import { RetentionNotice } from '@/components/meeting/retention-notice';
import { VisibilityBadge } from '@/components/meetings/badges';
import { formatClock, formatDuration } from '@/components/meetings/format';
import { Button } from '@/components/ui/button';
import { UploadButton } from '@/components/upload/new-meeting-menu';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { parseStartAt } from '@/lib/meetings/library-params';
import { loadMeeting, meetingState } from '@/lib/meetings/queries';
import { pageUser } from '@/lib/page-user';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const UPLOAD_FAILURES = ['hash_mismatch', 'size_mismatch', 'session_expired'];

/** One panel's state message: an icon, a title, a line, and the next step. */
function PanelState({
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

/*
  A meeting (figure 04, figure 10 on a phone): title, metadata, the actions
  row, the player, and Recap and Transcript as tabs. The transcript and recap
  themselves arrive in packets 4 and 5; this page shows where each stands.
  `?t=1834` opens the transcript tab with the player at 30:34 (rule 5).
*/
export default async function MeetingPage({ params, searchParams }: Props) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, pageUser()]);
  const { db, installId } = await getAdapters();
  const detail = await loadMeeting(db, installId, user, id);
  // Not readable looks the same as absent: a link is never permission.
  if (!detail) notFound();

  const [t, tv, ts, tf, tlocale, settings] = await Promise.all([
    getTranslations('meeting'),
    getTranslations('visibility'),
    getTranslations('status'),
    getTranslations('format'),
    getTranslations('locale'),
    getInstallSettings(),
  ]);
  const { meeting, access, recordings, current, hasRecap } = detail;
  const intl = tlocale('intl');
  const owner = access === 'owner';
  const state = meetingState(current?.status);
  const audioReady =
    current?.confirmedAt && !(current.failure && UPLOAD_FAILURES.includes(current.failure));
  const rawT = Array.isArray(query.t) ? query.t[0] : query.t;
  const startAt = parseStartAt(rawT);
  const canUpload = settings.recordingSources.includes('upload');

  const transcriptPanel = (() => {
    if (!current) {
      return (
        <PanelState
          Icon={FileText}
          title={t('transcript.none.title')}
          body={t('transcript.none.body')}
        >
          {owner && canUpload && (
            <UploadButton label={t('transcript.none.action')} meetingId={meeting.id} />
          )}
        </PanelState>
      );
    }
    if (
      current.status === 'failed' &&
      current.failure &&
      UPLOAD_FAILURES.includes(current.failure)
    ) {
      return (
        <PanelState
          tone="warning"
          Icon={TriangleAlert}
          title={t('transcript.uploadFailed.title')}
          body={t('transcript.uploadFailed.body', { reason: current.failure })}
        >
          {owner && canUpload && (
            <UploadButton label={t('transcript.uploadFailed.action')} meetingId={meeting.id} />
          )}
        </PanelState>
      );
    }
    if (current.status === 'failed') {
      return (
        <PanelState
          tone="warning"
          Icon={TriangleAlert}
          title={t('transcript.failed.title')}
          body={
            settings.sttProvider
              ? t('transcript.failed.body', { provider: settings.sttProvider })
              : t('transcript.failed.bodyUnknown')
          }
        >
          {owner && (
            <RetryTranscription
              meetingId={meeting.id}
              recordingId={current.id}
              label={t('transcript.failed.retry')}
              failedLabel={t('transcript.failed.retryFailed')}
            />
          )}
          {user.isAdmin && (
            <Button asChild variant="quiet">
              <Link href="/settings">{t('transcript.failed.switchProvider')}</Link>
            </Button>
          )}
        </PanelState>
      );
    }
    if (current.status === 'uploading') {
      return (
        <PanelState
          Icon={Upload}
          title={t('transcript.uploading.title')}
          body={t('transcript.uploading.body')}
        />
      );
    }
    // confirmed, transcribing, and (until packet 4 renders it) transcribed.
    return (
      <PanelState
        Icon={Loader}
        title={t('transcript.transcribing.title')}
        body={t('transcript.transcribing.body')}
      />
    );
  })();

  const recapPanel = (
    <PanelState Icon={FileText} title={t('recap.pending.title')} body={t('recap.pending.body')} />
  );

  const meta = [
    <LocalTime key="date" date={meeting.startedAt} options={{ dateStyle: 'long' }} />,
    <LocalTime key="time" date={meeting.startedAt} options={{ timeStyle: 'short' }} />,
    current ? (
      <span key="duration">{formatDuration(tf, current.durationS)}</span>
    ) : (
      <span key="duration">{t('noRecording')}</span>
    ),
  ];

  const sourceLabel = (rec: Recording) => t(`source.${rec.source}`);
  const confirmed = recordings.filter((rec) => rec.confirmedAt);

  return (
    <div className="max-w-[904px]">
      <BackLink label={t('back')} />
      {meeting.archivedAt && <ArchivedNotice meetingId={meeting.id} owner={owner} />}

      <header className="grid gap-2">
        <MeetingTitle meetingId={meeting.id} title={meeting.title} canRename={owner} />
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {meta.flatMap((item, i) =>
            i === 0
              ? [item]
              : [
                  <span key={`sep-${i}`} aria-hidden="true" className="text-text-muted">
                    ·
                  </span>,
                  item,
                ],
          )}
        </p>
        <RetentionNotice deleteAt={null} />
      </header>

      <div className="my-5 mb-6 flex flex-wrap items-center gap-2">
        {owner ? (
          <label className="inline-flex items-center gap-2 text-xs" title={t('visibility.later')}>
            <Lock aria-hidden="true" className="size-5" strokeWidth={1.5} />
            <select
              disabled
              value={meeting.visibility}
              aria-label={t('visibility.label')}
              title={t('visibility.later')}
              className="min-h-10 rounded-control border border-input bg-card px-3 text-sm disabled:opacity-60 max-shell:min-h-11 max-shell:text-xs"
            >
              {(['private', 'shared', 'company'] as const).map((v) => (
                <option key={v} value={v}>
                  {tv(v)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <VisibilityBadge visibility={meeting.visibility} />
        )}
        {owner && <KeepToggle meetingId={meeting.id} keep={meeting.keep} />}
        <div className="grow" />
        {/* The primary action, disabled until export exists (rule 10). */}
        <span title={t('exportLater')}>
          <Button
            variant="primary"
            disabled
            aria-describedby="export-later"
            className="max-shell:text-xs"
          >
            <Download aria-hidden="true" />
            {t('export')}
          </Button>
          <span id="export-later" className="sr-only">
            {t('exportLater')}
          </span>
        </span>
        {owner && (
          <MeetingMenu
            meetingId={meeting.id}
            archived={Boolean(meeting.archivedAt)}
            recordings={recordings.length}
            hasRecap={hasRecap}
            canUpload={canUpload}
          />
        )}
      </div>

      {current && audioReady && (
        <AudioPlayer
          src={`/api/v1/recordings/${current.id}/audio`}
          durationS={current.durationS}
          start={startAt}
        />
      )}

      {recordings.length > 1 && (
        <section aria-labelledby="recordings-heading" className="mb-6">
          <h2 id="recordings-heading" className="mb-2 text-sm font-[550]">
            {t('recordings.heading')}
          </h2>
          <ul className="overflow-hidden rounded-card border border-border bg-card text-sm">
            {recordings.map((rec) => (
              <li
                key={rec.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle px-4 py-2 last:border-b-0"
              >
                <span>{sourceLabel(rec)}</span>
                <span className="text-muted-foreground tabular-nums">
                  <LocalTime
                    date={rec.createdAt}
                    options={{ dateStyle: 'medium', timeStyle: 'short' }}
                  />{' '}
                  · {formatClock(rec.durationS)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {ts(meetingState(rec.status))}
                </span>
                <span className="grow" />
                {rec.isPrimary ? (
                  <span className="text-xs text-accent-strong">{t('recordings.primary')}</span>
                ) : (
                  owner &&
                  confirmed.includes(rec) &&
                  !(rec.failure && UPLOAD_FAILURES.includes(rec.failure)) && (
                    <MakePrimary
                      meetingId={meeting.id}
                      recordingId={rec.id}
                      label={t('recordings.makePrimary')}
                      ariaLabel={t('recordings.makePrimaryLabel', {
                        // A label, not shown: UTC is close enough to tell recordings apart.
                        date: new Intl.DateTimeFormat(intl, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                          timeZone: 'UTC',
                        }).format(rec.createdAt),
                      })}
                      failedLabel={t('recordings.failed')}
                    />
                  )
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <MeetingTabs
        label={t('tabs.label')}
        initial={hasRecap && startAt === undefined && state === 'ready' ? 'recap' : 'transcript'}
        tabs={[
          { value: 'recap', label: t('tabs.recap'), panel: recapPanel },
          {
            value: 'transcript',
            label: t('tabs.transcript'),
            count: current ? formatClock(current.durationS) : undefined,
            panel: transcriptPanel,
          },
        ]}
      />
    </div>
  );
}
