/*
  The recap prompt (docs/decisions.md, packet 5). One system prompt with the
  rules, one user message with the template and then the transcript as
  "Speaker: text" lines, a "[mm:ss]" line at every new minute. A transcript
  too long for the model's context is cut into parts by line, each part
  summarised first, and the recap drafted from the summaries.

  Pure: the job hands it the rows and gets back the calls to make.
*/
import { RECAP_MAX_TOKENS, SUMMARY_MAX_TOKENS } from './models';

export interface PromptSegment {
  startMs: number;
  /** The colleague's name for a linked speaker, else the label; null when the provider gave no speaker. */
  speaker: string | null;
  text: string;
}

export interface PromptInput {
  template: string;
  segments: readonly PromptSegment[];
  keyterms: readonly string[];
  /** ISO 639-1 of the transcript, or '' / 'auto' when unknown. */
  language: string;
  /** The model's context window, in tokens. */
  contextTokens: number;
}

export interface Call {
  system: string;
  user: string;
  maxTokens: number;
}

/** The template used when the install has none. Headings in English; the model writes in the transcript's language. */
export const FALLBACK_TEMPLATE = `# Summary

## Discussion

## Decisions

## Open questions
`;

/** A conservative token estimate: three characters a token (Danish runs longer per token than English). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);
/** Room for the message framing and the model's own overhead. */
const MARGIN = 600;

const clock = (ms: number) => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:00` : `${pad(m)}:00`;
};

/** The transcript as lines: "[mm:00]" at every new minute, then "Speaker: text". */
export function transcriptLines(segments: readonly PromptSegment[]): string[] {
  const lines: string[] = [];
  let minute = -1;
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const m = Math.floor(s.startMs / 60_000);
    if (m !== minute) {
      lines.push(`[${clock(m * 60_000)}]`);
      minute = m;
    }
    lines.push(s.speaker ? `${s.speaker}: ${text}` : text);
  }
  return lines;
}

export function languageName(code: string): string | null {
  if (!code || code === 'auto') return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? null;
  } catch {
    return null;
  }
}

/** The rules every recap call follows. */
export function systemPrompt(language: string, keyterms: readonly string[]): string {
  const name = languageName(language);
  const rules = [
    'You write the recap of a meeting from its transcript.',
    name
      ? `Write in ${name}, the language of the transcript.`
      : 'Write in the language of the transcript.',
    "Follow the template's markdown structure exactly: keep every heading of the template, in its order and with its wording, and fill each section from the transcript. When the meeting said nothing for a section, write one short line saying so.",
    'Write the decisions and agreed actions as a markdown checklist ("- [ ] ...") in the template\'s section for decisions, or under a heading for decisions, in the language of the recap, when the template has none.',
    'When a speaker clearly took a decision or an action, end its checklist item with "@" and the speaker\'s name exactly as the transcript writes it, for example "@Anne Holm". Give no owner when it is not clear.',
    'Do not invent facts, names, numbers or dates. Mark anything you are not sure of with "(unclear)", written in the language of the recap.',
    'Answer with the markdown of the recap only: no preamble, no closing remark, no code fence.',
  ];
  if (keyterms.length) {
    rules.push(`Spell these terms as written here: ${keyterms.slice(0, 200).join(', ')}.`);
  }
  return rules.map((r) => `- ${r}`).join('\n');
}

function summarySystem(language: string, keyterms: readonly string[]): string {
  const name = languageName(language);
  return [
    '- You summarise one part of a long meeting transcript, so that a recap can be written from the summaries of all its parts.',
    name ? `- Write in ${name}.` : '- Write in the language of the transcript.',
    '- Keep every decision, agreed action and its owner (as "@" and the speaker\'s name exactly as written), every number and date, and every open question. Keep the times in brackets where topics change.',
    '- Do not invent anything. Answer with the summary only.',
    ...(keyterms.length
      ? [`- Spell these terms as written here: ${keyterms.slice(0, 200).join(', ')}.`]
      : []),
  ].join('\n');
}

const userMessage = (template: string, transcriptHeading: string, body: string) =>
  `Template:\n\n${template.trim()}\n\n${transcriptHeading}\n\n${body}`;

/**
 * A line of at most `budget` estimated tokens: a longer one is cut at
 * sentence ends, a sentence still too long at spaces, and a word still too
 * long by characters. The speaker's name goes on every piece.
 */
export function splitLine(line: string, budget: number): string[] {
  if (estimateTokens(line) <= budget) return [line];
  const speaker = /^([^:[\]]{1,60}): /.exec(line)?.[1];
  const text = speaker ? line.slice(speaker.length + 2) : line;
  const prefix = speaker ? `${speaker}: ` : '';
  const room = Math.max(1, budget - estimateTokens(prefix));
  const pieces: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if (current && estimateTokens(`${current} ${piece}`) > room) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${piece}` : piece;
  };
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (estimateTokens(sentence) <= room) push(sentence);
    else
      for (const word of sentence.split(/\s+/)) {
        if (estimateTokens(word) <= room) push(word);
        else for (let i = 0; i < word.length; i += room * 3) push(word.slice(i, i + room * 3));
      }
  }
  if (current) pieces.push(current);
  return pieces.map((piece) => prefix + piece);
}

/** Splits lines into parts of at most `budget` estimated tokens, a long line split first. */
export function splitLines(lines: readonly string[], budget: number): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  let minute: string | null = null;
  for (const line of lines.flatMap((l) => splitLine(l, Math.max(1, Math.floor(budget / 2))))) {
    const cost = estimateTokens(line) + 1;
    if (current.length && size + cost > budget) {
      parts.push(current);
      current = [];
      size = 0;
    }
    // A part starts with its minute, so its summary can say when.
    if (!current.length && !line.startsWith('[') && minute) {
      current.push(minute);
      size += estimateTokens(minute) + 1;
    }
    if (line.startsWith('[')) minute = line;
    current.push(line);
    size += cost;
  }
  if (current.length) parts.push(current);
  return parts;
}

/** The estimated tokens of a call, its answer's cap included: what must fit the model's context. */
export const callTokens = (call: Call) =>
  estimateTokens(call.system) + estimateTokens(call.user) + call.maxTokens;

export const SUMMARY_HEADING = 'Summaries of consecutive parts of the transcript, in order:';

/**
 * What one draft may spend. `scale` shrinks the room for transcript and
 * summaries (a second try after an incomplete draft); the template and the
 * answer's cap keep theirs. Null when the template cannot fit even alone.
 */
export function planBudgets(input: PromptInput, scale = 1) {
  const template = input.template.trim() || FALLBACK_TEMPLATE;
  const system = systemPrompt(input.language, input.keyterms);
  const summary = summarySystem(input.language, input.keyterms);
  const headingTokens = estimateTokens(SUMMARY_HEADING) + 20;
  const finalRoom = Math.floor(
    (input.contextTokens -
      RECAP_MAX_TOKENS -
      estimateTokens(system) -
      estimateTokens(userMessage(template, SUMMARY_HEADING, '')) -
      MARGIN) *
      scale,
  );
  const partRoom = Math.floor(
    (input.contextTokens - SUMMARY_MAX_TOKENS - estimateTokens(summary) - MARGIN - headingTokens) *
      scale,
  );
  // Room for less than a few minutes of transcript is no room.
  if (finalRoom < 500 || partRoom < 500) return null;
  return { template, system, summary, finalRoom, partRoom };
}

/** The final call: the template, then the transcript, or the summaries of its parts. */
export function draftCall(
  budgets: NonNullable<ReturnType<typeof planBudgets>>,
  body: string,
  summarised: boolean,
): Call {
  return {
    system: budgets.system,
    user: userMessage(budgets.template, summarised ? SUMMARY_HEADING : 'Transcript:', body),
    maxTokens: RECAP_MAX_TOKENS,
  };
}

/** One summary call: a part of the transcript, or (`level` 2 and up) a run of earlier summaries. */
export function summaryCall(
  budgets: NonNullable<ReturnType<typeof planBudgets>>,
  part: readonly string[],
  index: number,
  count: number,
  level: number,
): Call {
  const what = level === 1 ? 'of the transcript' : 'of the summaries of the transcript';
  return {
    system: budgets.summary,
    user: `Part ${index + 1} of ${count} ${what}:\n\n${part.join('\n')}`,
    maxTokens: SUMMARY_MAX_TOKENS,
  };
}

/** The template's headings, which a finished draft must keep (none for the plain fallback). */
export function requiredHeadings(template: string): string[] {
  if (!template.trim()) return [];
  return headingsOf(template);
}

/** The headings of a markdown text, normalised for comparison; code blocks are skipped. */
export function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) out.push(normalizeHeading(match[1]!));
  }
  return out;
}

const normalizeHeading = (text: string) =>
  text
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:.]+$/, '')
    .trim()
    .toLocaleLowerCase();

/** The model's answer as markdown: a wrapping code fence and any preamble before the first heading go. */
export function cleanAnswer(text: string): string {
  let out = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(out);
  if (fence) out = fence[1]!.trim();
  return out;
}
