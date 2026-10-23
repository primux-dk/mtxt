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
import {
  callTokens,
  cleanAnswer,
  draftCall,
  estimateTokens,
  headingsOf,
  planBudgets,
  requiredHeadings,
  splitLine,
  splitLines,
  summaryCall,
  transcriptLines,
  type Call,
  type PromptInput,
  type PromptSegment,
} from './prompt';
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

/** The template body: the meeting's, else the install's default, else '' (the prompt's plain one). */
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
  // No template at all: '' here, and the prompt uses its plain one with nothing required.
  return { id: template?.id ?? null, bodyMd: template?.bodyMd ?? '' };
}

/** Rounds of summaries of summaries before a draft gives up as too long. */
const MAX_LEVELS = 5;

/**
 * One draft at the given scale of the budgets: the transcript whole when it
 * fits, else summaries of its parts, and summaries of those, until the final
 * call fits the model's context with the template and the answer's cap.
 * Every call is checked against the context with the same estimator.
 */
async function draftOnce(
  llm: RecapLlm,
  input: PromptInput,
  scale: number,
): Promise<{ markdown: string; truncated: boolean; parts: number }> {
  const budgets = planBudgets(input, scale);
  if (!budgets) throw new RecapError('template_too_long');
  const call = async (c: Call) => {
    if (callTokens(c) > input.contextTokens) throw new RecapError('internal');
    const out = await llm.complete(c);
    const text = cleanAnswer(out.text);
    if (!text) throw new RecapError('empty', true, undefined, llm.provider);
    return { text, truncated: out.truncated };
  };
  const lines = transcriptLines(input.segments).flatMap((l) => splitLine(l, budgets.finalRoom));
  const transcript = lines.join('\n');
  if (estimateTokens(transcript) <= budgets.finalRoom) {
    const out = await call(draftCall(budgets, transcript, false));
    return { markdown: out.text, truncated: out.truncated, parts: 0 };
  }
  let texts = lines;
  let parts = 0;
  for (let level = 1; ; level++) {
    if (level > MAX_LEVELS) throw new RecapError('too_long');
    const groups = splitLines(texts, budgets.partRoom);
    if (level > 1 && groups.length >= texts.length) throw new RecapError('too_long');
    const summaries: string[] = [];
    for (const [i, group] of groups.entries()) {
      summaries.push((await call(summaryCall(budgets, group, i, groups.length, level))).text);
    }
    if (level === 1) parts = groups.length;
    texts = summaries.map((summary, i) => `Part ${i + 1}: ${summary.replace(/\s*\n\s*/g, ' ')}`);
    const body = texts.join('\n\n');
    if (estimateTokens(body) <= budgets.finalRoom) {
      const out = await call(draftCall(budgets, body, true));
      return { markdown: out.text, truncated: out.truncated, parts };
    }
  }
}

/** Whether a draft is finished: not cut off at the cap, and with every heading of the template. */
export function draftComplete(markdown: string, truncated: boolean, template: string) {
  if (truncated) return false;
  const have = new Set(headingsOf(markdown));
  return requiredHeadings(template).every((heading) => have.has(heading));
}

/**
 * The draft's markdown and its version note. A draft cut off at the cap, or
 * missing a heading of the template, is tried once more with half the room
 * for the transcript; a second incomplete one fails as `incomplete_draft`
 * and is never stored as finished.
 */
export async function draftRecap(
  llm: RecapLlm,
  input: PromptInput,
): Promise<{ markdown: string; note: string | null }> {
  for (const scale of [1, 0.5]) {
    const out = await draftOnce(llm, input, scale);
    if (draftComplete(out.markdown, out.truncated, input.template)) {
      return { markdown: out.markdown, note: out.parts ? chunkedNote(out.parts) : null };
    }
  }
  throw new RecapError('incomplete_draft');
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
