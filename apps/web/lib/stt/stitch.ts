/*
  One transcript from the pieces of a cut recording (docs/decisions.md,
  packet 17). Each piece's times move by the piece's start in the
  original. Two neighbours share the overlap around their seam, so the
  words there come twice: the stitcher looks for the same run of words on
  both sides near the seam and cuts inside it, so every word is kept once;
  with no such run, a word belongs to the piece whose side of the seam its
  middle falls on. A segment cut by that keeps its own words, the text
  rebuilt from them. Speakers keep their numbers: a provider that labels by
  number per piece (Whisper has one speaker, "Speaker 1") lines up as is.
*/
import type { SttResult, SttSegment, SttSpeaker, SttWord } from './types';

export interface StitchPiece {
  /** Where the piece's own time 0 is in the original, ms. */
  startMs: number;
  /** The piece owns what lies between its seams. */
  seamStartMs: number;
  seamEndMs: number;
  result: Pick<SttResult, 'language' | 'model' | 'segments' | 'speakers' | 'words'>;
}

interface Token extends SttWord {
  /** The segment it belongs to, in its piece. */
  segment: number;
  norm: string;
}

/** How far from the seam the stitcher looks for words both pieces heard. */
const MATCH_WINDOW_MS = 6_000;
/** Two copies of a word are the same word only this close in time. */
const MATCH_DRIFT_MS = 1_500;
/** A shorter run of shared words could be chance ("the", "and"). */
const MIN_RUN = 2;

const normalise = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const mid = (w: { startMs: number; endMs: number }) => (w.startMs + w.endMs) / 2;

/**
 * A piece's words, moved to the original's time, each tied to its segment.
 * A segment without words gets its text split evenly over its span.
 */
function tokens(piece: StitchPiece): { tokens: Token[]; segments: SttSegment[] } {
  const shift = piece.startMs;
  const segments = piece.result.segments.map((s) => ({
    ...s,
    startMs: s.startMs + shift,
    endMs: Math.max(s.endMs, s.startMs) + shift,
  }));
  const words = (piece.result.words ?? [])
    .map((w) => ({ ...w, startMs: w.startMs + shift, endMs: Math.max(w.endMs, w.startMs) + shift }))
    .filter((w) => normalise(w.text));
  const out: Token[] = [];
  let w = 0;
  segments.forEach((segment, index) => {
    const own: Token[] = [];
    // Words come in order; a word belongs to the segment its middle lies in, or the nearest after.
    while (w < words.length && mid(words[w]!) <= segment.endMs) {
      const word = words[w++]!;
      own.push({
        ...word,
        speaker: word.speaker ?? segment.speaker,
        segment: index,
        norm: normalise(word.text),
      });
    }
    if (!own.length) {
      const parts = segment.text.split(/\s+/).filter((p) => normalise(p));
      const step = (segment.endMs - segment.startMs) / Math.max(1, parts.length);
      parts.forEach((text, i) =>
        own.push({
          text,
          startMs: Math.round(segment.startMs + i * step),
          endMs: Math.round(segment.startMs + (i + 1) * step),
          speaker: segment.speaker,
          segment: index,
          norm: normalise(text),
        }),
      );
    }
    out.push(...own);
  });
  // Words after the last segment's end belong to it.
  while (w < words.length && segments.length) {
    const word = words[w++]!;
    out.push({
      ...word,
      speaker: word.speaker ?? segments.at(-1)!.speaker,
      segment: segments.length - 1,
      norm: normalise(word.text),
    });
  }
  return { tokens: out, segments };
}

/**
 * Where to cut between two pieces' tokens: A keeps [0, a), B keeps [b, end).
 * The longest run both heard near the seam, cut in its middle; else the seam itself.
 */
export function seamCut(a: readonly Token[], b: readonly Token[], seamMs: number) {
  const aFrom = a.findIndex((t) => mid(t) >= seamMs - MATCH_WINDOW_MS);
  const aStart = aFrom < 0 ? a.length : aFrom;
  let bEnd = b.findIndex((t) => mid(t) > seamMs + MATCH_WINDOW_MS);
  if (bEnd < 0) bEnd = b.length;
  let best = { length: 0, i: 0, j: 0, drift: Infinity };
  for (let i = aStart; i < a.length; i++) {
    for (let j = 0; j < bEnd; j++) {
      let k = 0;
      while (
        i + k < a.length &&
        j + k < bEnd &&
        a[i + k]!.norm === b[j + k]!.norm &&
        Math.abs(mid(a[i + k]!) - mid(b[j + k]!)) <= MATCH_DRIFT_MS
      ) {
        k++;
      }
      if (k < MIN_RUN) continue;
      const drift = Math.abs((mid(a[i]!) + mid(a[i + k - 1]!)) / 2 - seamMs);
      if (k > best.length || (k === best.length && drift < best.drift)) {
        best = { length: k, i, j, drift };
      }
    }
  }
  if (best.length) {
    const half = Math.floor(best.length / 2);
    return { a: best.i + half, b: best.j + half, matched: best.length };
  }
  const a1 = a.findIndex((t) => mid(t) >= seamMs);
  const b1 = b.findIndex((t) => mid(t) >= seamMs);
  return { a: a1 < 0 ? a.length : a1, b: b1 < 0 ? b.length : b1, matched: 0 };
}

/** The kept tokens back into segments: a whole segment as it was, a cut one rebuilt. */
function rebuild(segments: readonly SttSegment[], all: readonly Token[], kept: readonly Token[]) {
  const counts = new Map<number, number>();
  for (const t of all) counts.set(t.segment, (counts.get(t.segment) ?? 0) + 1);
  const bySegment = new Map<number, Token[]>();
  for (const t of kept) {
    const list = bySegment.get(t.segment) ?? [];
    list.push(t);
    bySegment.set(t.segment, list);
  }
  const out: SttSegment[] = [];
  for (const [index, own] of [...bySegment].sort((x, y) => x[0] - y[0])) {
    const segment = segments[index]!;
    if (own.length === counts.get(index)) {
      out.push(segment);
      continue;
    }
    out.push({
      startMs: own[0]!.startMs,
      endMs: own.at(-1)!.endMs,
      text: own.map((t) => t.text.trim()).join(' '),
      speaker: segment.speaker,
    });
  }
  return out;
}

/** The pieces as one result. `raw` says how many pieces there were; each piece's own raw result is stored apart. */
export function stitch(pieces: readonly StitchPiece[]): SttResult {
  const prepared = pieces.map(tokens);
  const keepFrom = prepared.map(() => 0);
  const keepTo = prepared.map((p) => p.tokens.length);
  for (let k = 0; k + 1 < pieces.length; k++) {
    const cut = seamCut(
      prepared[k]!.tokens.slice(keepFrom[k]),
      prepared[k + 1]!.tokens,
      pieces[k]!.seamEndMs,
    );
    keepTo[k] = keepFrom[k]! + cut.a;
    keepFrom[k + 1] = cut.b;
  }
  const segments: SttSegment[] = [];
  const words: SttWord[] = [];
  const speakers = new Map<number, SttSpeaker>();
  const languages = new Map<string, number>();
  prepared.forEach((p, k) => {
    const kept = p.tokens.slice(keepFrom[k], Math.max(keepFrom[k]!, keepTo[k]!));
    segments.push(...rebuild(p.segments, p.tokens, kept));
    words.push(
      ...kept.map(({ startMs, endMs, text, speaker }) => ({ startMs, endMs, text, speaker })),
    );
    for (const s of pieces[k]!.result.speakers) {
      const known = speakers.get(s.index);
      if (!known || (!known.label && s.label)) speakers.set(s.index, s);
    }
    const language = pieces[k]!.result.language;
    if (language) languages.set(language, (languages.get(language) ?? 0) + kept.length + 1);
  });
  segments.sort((x, y) => x.startMs - y.startMs);
  const used = new Set(segments.map((s) => s.speaker));
  return {
    language: [...languages].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '',
    model: pieces[0]?.result.model ?? '',
    segments,
    speakers: [...speakers.values()]
      .filter((s) => used.has(s.index))
      .sort((x, y) => x.index - y.index),
    ...(words.length ? { words } : {}),
    raw: { pieces: pieces.length },
  };
}
