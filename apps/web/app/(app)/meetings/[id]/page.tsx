import { FileText, Loader, MicOff, Trash2, TriangleAlert, Upload } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cn } from 'cn';
import { audit, retentionNotice, type Recording } from '@mtxt/adapters';
import { AudioPlayer } from '@/components/meeting/audio-player';
import { BackLink } from '@/components/meeting/back-link';
import { KeepProvider } from '@/components/meeting/keep-state';
import { KeepToggle } from '@/components/meeting/keep-toggle';
import { ArchivedNotice, MeetingMenu } from '@/components/meeting/meeting-menu';
import { MeetingTabs } from '@/components/meeting/meeting-tabs';
import { MeetingTitle } from '@/components/meeting/meeting-title';
import { MakePrimary, RetryTranscription } from '@/components/meeting/recording-actions';
import { LocalTime } from '@/components/local-time';
import { RetentionNotice } from '@/components/meeting/retention-notice';
import { RefreshWhile } from '@/components/meeting/refresh-while';
import { VisibilityControl } from '@/components/meeting/visibility-control';
import { VisibilityBadge } from '@/components/meetings/badges';
import { TranscriptView } from '@/components/transcript/transcript-view';
import { ExportDialog } from '@/components/recap/export-dialog';
import { RecapPanel } from '@/components/recap/recap-panel';
import { recapPanelData } from '@/lib/recap/panel-data';
import { formatClock, formatDuration } from '@/components/meetings/format';
import { Button } from '@/components/ui/button';
import { UploadButton } from '@/components/upload/new-meeting-menu';
import { getAdapters, getInstallSettings } from '@/lib/install';
import { parseStartAt } from '@/lib/meetings/library-params';
import { loadMeeting, meetingState } from '@/lib/meetings/queries';
import { requireUser } from '@/lib/auth/session';
import { keytermList } from '@/lib/transcription/job';
import { isSttFailure, parseReason } from '@/lib/stt/types';
import { loadTranscript } from '@/lib/transcript/queries';
import { connectedLabel } from '@/lib/webhooks/rules';
import { listEndpoints } from '@/lib/webhooks/store';

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
  row, the player, and Recap and Transcript as tabs. The transcript tab has
  four states (rule 8): transcribing, failed with its two next steps (rule
  9), the transcript, and no speech. The recap tab is components/recap.
  `?t=1834` opens the transcript tab with the player at 30:34 (rule 5).
*/
export default async function MeetingPage({ params, searchParams }: Props) {
  const [{ id }, query, user] = await Promise.all([params, searchParams, requireUser()]);
  const { db, installId } = await getAdapters();
  const detail = await loadMeeting(db, installId, user, id);
  // Not readable looks the same as absent: a link is never permission.
  if (!detail) notFound();
  // Who opened what: anyone but the owner, once an hour per meeting.
  if (detail.access !== 'owner') {
    await audit(db, installId, {
      userId: user.id,
      meetingId: detail.meeting.id,
      meetingTitle: detail.meeting.title,
      action: 'opened',
    }).catch((error) => console.error('Could not write the audit row', error));
  }

  const { meeting, access, recordings, current, hasRecap, hasTranscript, shares } = detail;
  const [t, tr, ts, tf, tlocale, tt, tstt, settings, view, keyterms, trecap] = await Promise.all([
    getTranslations('meeting'),
    getTranslations('retention'),
    getTranslations('status'),
    getTranslations('format'),
    getTranslations('locale'),
    getTranslations('transcript'),
    getTranslations('settings.stt'),
    getInstallSettings(),
    current ? loadTranscript(db, installId, meeting.id, current.id) : Promise.resolve(null),
    keytermList(db, installId),
    getTranslations('recap'),
  ]);
  // The owner's "Send to connected systems" shows only while an endpoint is enabled.
  const endpoints = access === 'owner' ? await listEndpoints(db, installId) : [];
  const connected = endpoints.some((e) => e.enabled) ? { label: connectedLabel(endpoints) } : null;
  const recapData = await recapPanelData(
    db,
    installId,
    meeting,
    access === 'owner',
    trecap as unknown as Parameters<typeof recapPanelData>[4],
  );
  const intl = tlocale('intl');
  const owner = access === 'owner';
  const state = meetingState(current?.status);
  const audioReady =
    current?.confirmedAt &&
    current.storagePath &&
    !(current.failure && UPLOAD_FAILURES.includes(current.failure));
  // Retention: audio and text deadlines from started_at and the settings (rule 3).
  // Computed as if not kept: the notice reads the live keep flag and says "Kept" instead.
  const notice = retentionNotice({ ...meeting, keep: false }, settings, {
    audio: recordings.some((rec) => rec.storagePath),
    text: hasTranscript || hasRecap,
  });
  const audioDeletedAt = current && !current.storagePath ? current.deleteAudioAt : null;
  const rawT = Array.isArray(query.t) ? query.t[0] : query.t;
  const startAt = parseStartAt(rawT);
  const canUpload = settings.recordingSources.includes('upload');
  const providerLabel = (id: string | null | undefined) => {
    switch (id) {
      case 'assemblyai':
      case 'azure':
      case 'elevenlabs':
        return tstt(`providers.${id}`);
      case 'workers-ai-whisper':
        return tstt('providers.workersAi');
      case 'local-whisper':
        return tstt('local', { model: 'Whisper' });
      case 'local-parakeet':
        return tstt('local', { model: 'Parakeet' });
      default:
        return tt('providerUnknown');
    }
  };
  // The provider that ran, or is running, the transcript; else the one chosen now.
  const provider = providerLabel(view?.transcript.provider ?? settings.sttProvider);
  const transcribed = current?.status === 'transcribed' && view?.transcript.status === 'done';
  const speakerCount = transcribed
    ? new Set(view.segments.map((g) => g[2]).filter(Boolean)).size
    : 0;
  const languageName = (code: string) => {
    if (!code) return tt('languageUnknown');
    try {
      const name = new Intl.DisplayNames([tlocale('intl')], { type: 'language' }).of(code) ?? code;
      return name.charAt(0).toLocaleUpperCase() + name.slice(1);
    } catch {
      return code;
    }
  };

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
      const code = isSttFailure(current.failure) ? current.failure : 'stt_failed';
      // A fixed reason and the HTTP status; a provider's own words are never stored.
      const reason = parseReason(current.failureReason);
      return (
        <PanelState
          tone="warning"
          Icon={TriangleAlert}
          title={tt('state.failed.title')}
          body={tt(`failure.${code}`, { provider })}
        >
          {reason && (
            <p className="basis-full text-xs break-words text-muted-foreground">
              {tt('state.failed.detail', {
                reason: tt(`reason.${reason.reason}`, { status: reason.status ?? 'none' }),
              })}
            </p>
          )}
          {owner && (
            <RetryTranscription
              meetingId={meeting.id}
              recordingId={current.id}
              label={tt('state.failed.retry')}
              failedLabel={tt('state.failed.retryFailed')}
            />
          )}
          {user.isAdmin ? (
            <Button asChild variant="quiet">
              <Link href="/settings/transcription">{tt('state.failed.switchProvider')}</Link>
            </Button>
          ) : (
            <p className="basis-full text-xs text-muted-foreground">
              {tt('state.failed.askAdmin')}
            </p>
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
    if (transcribed && view.segments.length === 0) {
      return (
        <PanelState
          Icon={MicOff}
          title={tt('state.empty.title')}
          body={tt('state.empty.body', { provider })}
        />
      );
    }
    if (transcribed) {
      return (
        <TranscriptView
          meetingId={meeting.id}
          canEdit={owner}
          segments={view.segments}
          speakers={view.speakers}
          keyterms={keyterms}
          durationS={current.durationS}
          language={view.transcript.language}
          languageName={languageName(view.transcript.language)}
          startAt={startAt}
        />
      );
    }
    // Confirmed or transcribing: a calm line with the provider, and the page looks again
    // every few seconds so the transcript appears without a reload.
    const waiting = !view && !settings.sttProvider;
    // A recording in pieces says how far it has come (packet 17).
    const pieces = view?.transcript.chunksTotal ?? 0;
    // The heading is the library badge's word for the state (rule 7).
    return (
      <PanelState
        Icon={Loader}
        title={ts('transcribing')}
        body={
          waiting
            ? tt('state.transcribing.waiting')
            : pieces > 1
              ? tt('state.transcribing.pieces', {
                  provider,
                  total: pieces,
                  done: view?.transcript.chunksDone ?? 0,
                })
              : tt('state.transcribing.body', { provider })
        }
      >
        <RefreshWhile seconds={8} />
      </PanelState>
    );
  })();

  const recapPanel = <RecapPanel meetingId={meeting.id} owner={owner} {...recapData} />;

  const meta = [
    <LocalTime key="date" date={meeting.startedAt} options={{ dateStyle: 'long' }} />,
    <LocalTime key="time" date={meeting.startedAt} options={{ timeStyle: 'short' }} />,
    current ? (
      <span key="duration">{formatDuration(tf, current.durationS)}</span>
    ) : (
      <span key="duration">{t('noRecording')}</span>
    ),
    ...(speakerCount ? [<span key="speakers">{t('speakers', { count: speakerCount })}</span>] : []),
  ];

  const sourceLabel = (rec: Recording) => t(`source.${rec.source}`);
  const confirmed = recordings.filter((rec) => rec.confirmedAt);

  return (
    <div className="max-w-[904px]">
      <BackLink label={t('back')} />
      {meeting.archivedAt && <ArchivedNotice meetingId={meeting.id} owner={owner} />}

      <KeepProvider meetingId={meeting.id} keep={meeting.keep}>
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
          <RetentionNotice notice={notice} owner={owner} />
        </header>

        <div className="my-5 mb-6 flex flex-wrap items-center gap-2">
          {owner ? (
            <VisibilityControl
              meetingId={meeting.id}
              title={meeting.title}
              visibility={meeting.visibility}
              shares={shares}
            />
          ) : (
            <VisibilityBadge visibility={meeting.visibility} />
          )}
          {owner && <KeepToggle />}
          <div className="grow" />
          {/* The primary action (rule 10): Markdown or Word, for anyone who may read the recap. */}
          <ExportDialog meetingId={meeting.id} available={Boolean(recapData.current)} />
          {owner && (
            <MeetingMenu
              meetingId={meeting.id}
              archived={Boolean(meeting.archivedAt)}
              recordings={recordings.length}
              hasRecap={hasRecap}
              canUpload={canUpload}
              connected={connected}
            />
          )}
        </div>
      </KeepProvider>

      {audioDeletedAt && (
        <p className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Trash2 aria-hidden="true" className="size-4" strokeWidth={1.5} />
          {tr.rich('audioDeleted', {
            date: () => <LocalTime date={audioDeletedAt} options={{ dateStyle: 'long' }} />,
          })}
        </p>
      )}

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
