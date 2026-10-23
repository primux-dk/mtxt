/*
  The recap job (docs/decisions.md, packet 5). Two ways in:

  - after a transcript (packet 4's outbox): taken once per transcript, and
    only when the meeting has no recap version yet and no draft running;
  - Regenerate draft and Try again (the owner): the action starts the draft
    and the message carries its token, so a duplicate delivery or an older
    draft cannot write over a newer one.

  The job loads the meeting's transcript with its speakers, the template
  (the meeting's, else the install's default, else a plain one), the
  keyterms and the language, builds the prompt (lib/recap/prompt.ts), calls
  the install's recap model, lifts the decisions, and writes version n+1
  with no author. A failure worth another try goes back to the queue, up to
  MAX_ATTEMPTS deliveries; otherwise the recap is `failed` with a fixed
  reason. The model's own words are only ever the recap.
*/
import { and, asc, desc, eq } from 'drizzle-orm';
import { readSettings, schema, type Db, type RecapJob, type Settings } from '@mtxt/adapters';
import { describeError } from '../stt/redact';
import { keytermList } from '../transcription/job';
import { liftDecisions, type MeetingSpeaker } from './decisions';
import { RecapError, type RecapLlm } from './llm';
import { parseMarkdown, toMarkdown } from './markdown';
import { contextTokens } from './models';
import { buildPlan, cleanAnswer, FALLBACK_TEMPLATE, type PromptSegment } from './prompt';
import { beginDraft, failDraft, holdsDraft, writeVersion } from './store';

export const MAX_ATTEMPTS = 3;

export interface RecapDeps {
  db: Db;
  installId: string;
  llm: (settings: Settings) => Promise<RecapLlm>;
  /** packet 4's guard: true the first time a transcript's recap job is taken. */
  takeOnce: (transcriptId: string) => Promise<boolean>;
  log?: Pick<Console, 'log' | 'error'>;
}

/** The version note of a draft made from summaries of parts: `chunked:<parts>`. */
export const chunkedNote = (parts: number) => `chunked:${parts}`;

/** The meeting's transcript as the prompt reads it: the primary recording's, else the newest done one. */
export async function transcriptFor(db: Db, installId: string, meetingId: string) {
  const t = schema.transcripts;
  const r = schema.recordings;
  const row = await db
    .select({ id: t.id, language: t.language })
    .from(t)
    .innerJoin(r, and(eq(r.id, t.recordingId), eq(r.installId, installId)))
    .where(
      and(
        eq(t.installId, installId),
        eq(r.meetingId, meetingId),
        eq(t.status, 'done'),
        eq(t.isComparison, false),
      ),
    )
    .orderBy(desc(r.isPrimary), desc(t.createdAt))
    .get();
  if (!row) return null;
  const g = schema.segments;
  const s = schema.speakers;
  const u = schema.users;
  const segments = await db
    .select({ startMs: g.startMs, text: g.text, label: s.label, userName: u.name })
    .from(g)
    .leftJoin(s, and(eq(s.id, g.speakerId), eq(s.installId, installId)))
    .leftJoin(u, and(eq(u.id, s.userId), eq(u.installId, installId)))
    .where(and(eq(g.installId, installId), eq(g.transcriptId, row.id)))
    .orderBy(asc(g.startMs), asc(g.id));
  const speakers = await db
    .select({ id: s.id, label: s.label, userId: s.userId, userName: u.name })
    .from(s)
    .leftJoin(u, and(eq(u.id, s.userId), eq(u.installId, installId)))
    .where(and(eq(s.installId, installId), eq(s.meetingId, meetingId)));
  return {
    id: row.id,
    language: row.language,
    segments: segments.map((g): PromptSegment => ({
      startMs: g.startMs,
      text: g.text,
      speaker: g.userName ?? g.label ?? null,
    })),
    speakers: speakers.map((sp): MeetingSpeaker => ({
      id: sp.id,
      name: sp.userName ?? sp.label,
      userId: sp.userId,
    })),
  };
}

/** The template body: the meeting's, else the install's default, else the plain one. */
export async function templateFor(db: Db, installId: string, templateId: string | null) {
  const tm = schema.templates;
  const chosen = templateId
    ? await db.query.templates.findFirst({
        where: and(eq(tm.id, templateId), eq(tm.installId, installId)),
      })
    : undefined;
  const template =
    chosen ??
    (await db.query.templates.findFirst({
      where: and(eq(tm.installId, installId), eq(tm.isDefault, true)),
    }));
  return { id: template?.id ?? null, bodyMd: template?.bodyMd ?? FALLBACK_TEMPLATE };
}

/** Calls the model for every step of the plan; the draft's markdown and its version note. */
export async function draftRecap(
  llm: RecapLlm,
  input: Parameters<typeof buildPlan>[0],
): Promise<{ markdown: string; note: string | null }> {
  const plan = buildPlan(input);
  const answer = async (call: { system: string; user: string; maxTokens: number }) => {
    const out = await llm.complete(call);
    const text = cleanAnswer(out.text);
    if (!text) throw new RecapError('empty', true, undefined, llm.provider);
    return text;
  };
  if (plan.kind === 'single') return { markdown: await answer(plan.call), note: null };
  const summaries: string[] = [];
  for (const part of plan.parts) summaries.push(await answer(part));
  return { markdown: await answer(plan.draft(summaries)), note: chunkedNote(plan.parts.length) };
}

export async function runRecap(deps: RecapDeps, job: RecapJob, attempt: number): Promise<void> {
  const { db, installId } = deps;
  const log = deps.log ?? console;
  const meeting = await db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, job.meeting_id), eq(schema.meetings.installId, installId)),
  });
  if (!meeting || meeting.deletedAt) {
    log.log('Recap job for a meeting that is gone; skipping', job.meeting_id);
    return;
  }

  let draft: { recapId: string; token: string };
  if (job.draft_token) {
    // Regenerate or Try again: the action started this draft; a newer one may have taken over.
    const recap = await db.query.recaps.findFirst({
      where: and(eq(schema.recaps.meetingId, meeting.id), eq(schema.recaps.installId, installId)),
    });
    if (!recap || !(await holdsDraft(db, installId, recap.id, job.draft_token))) {
      log.log('Recap draft superseded; skipping', job.meeting_id);
      return;
    }
    draft = { recapId: recap.id, token: job.draft_token };
  } else {
    // After a transcript: once per transcript, and only a first draft.
    if (attempt <= 1 && !(await deps.takeOnce(job.transcript_id))) {
      log.log('Recap job already taken; skipping', job.transcript_id);
      return;
    }
    const template = await templateFor(db, installId, meeting.templateId);
    const started = await beginDraft(db, installId, meeting.id, template.id, { onlyFirst: true });
    if (!started) {
      // A retried delivery finds its own draft running; anything else is not a first draft.
      const recap = await db.query.recaps.findFirst({
        where: and(eq(schema.recaps.meetingId, meeting.id), eq(schema.recaps.installId, installId)),
      });
      if (
        !recap ||
        recap.status !== 'drafting' ||
        recap.currentVersionId ||
        !recap.draftToken ||
        attempt <= 1
      ) {
        log.log('The meeting already has a recap; skipping the automatic draft', job.meeting_id);
        return;
      }
      draft = { recapId: recap.id, token: recap.draftToken };
    } else draft = started;
  }

  try {
    const settings = await readSettings(db, installId);
    const transcript = await transcriptFor(db, installId, meeting.id);
    if (!transcript || transcript.segments.length === 0) throw new RecapError('no_transcript');
    const recapRow = await db.query.recaps.findFirst({
      where: and(eq(schema.recaps.id, draft.recapId), eq(schema.recaps.installId, installId)),
    });
    const template = await templateFor(db, installId, recapRow?.templateId ?? meeting.templateId);
    const llm = await deps.llm(settings);
    const language = transcript.language || (settings.language === 'auto' ? '' : settings.language);
    const { markdown, note } = await draftRecap(llm, {
      template: template.bodyMd,
      segments: transcript.segments,
      keyterms: await keytermList(db, installId),
      language,
      contextTokens: contextTokens(llm.provider, llm.model),
    });
    const body = toMarkdown(liftDecisions(parseMarkdown(markdown), transcript.speakers));
    const written = await writeVersion(db, installId, {
      recapId: draft.recapId,
      meetingId: meeting.id,
      bodyMd: body,
      authorId: null,
      note,
      draftToken: draft.token,
    });
    if (!written.ok) log.log('Recap draft superseded before it was written', job.meeting_id);
    else log.log(`Recap drafted for ${meeting.id}: v${written.version.number}`);
  } catch (error) {
    const reason = error instanceof RecapError ? error : new RecapError('internal', true);
    if (reason.retryable && attempt < MAX_ATTEMPTS) {
      log.error('Recap draft failed; retrying', job.meeting_id, describeError(error));
      throw error;
    }
    log.error('Recap draft failed', job.meeting_id, describeError(error));
    await failDraft(db, installId, draft.recapId, draft.token, reason.stored);
  }
}
