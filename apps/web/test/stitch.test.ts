import { describe, expect, it } from 'vitest';
import { stitch, type StitchPiece } from '../lib/stt/stitch';
import type { SttSegment, SttWord } from '../lib/stt/types';

/*
  Packet 18: the stitcher. A synthetic meeting says word i from i*400 ms to
  i*400+300 ms. Each piece hears the words inside its own span, with times
  from its own start, grouped into segments of five words; neighbours
  overlap around the seam, so the words there come twice.
*/
const word = (i: number, shift = 0, text = `w${i}`): SttWord => ({
  startMs: i * 400 + shift,
  endMs: i * 400 + 300 + shift,
  text,
  speaker: 0,
});

function piece(
  fromMs: number,
  toMs: number,
  seams: [number, number],
  options: {
    jitter?: number;
    speaker?: (i: number) => number;
    words?: boolean;
    rename?: Record<number, string>;
  } = {},
): StitchPiece {
  const ids: number[] = [];
  for (let i = 0; i * 400 + 300 <= toMs; i++) if (i * 400 >= fromMs) ids.push(i);
  const speaker = options.speaker ?? (() => 0);
  const words = ids.map((i) => ({
    ...word(i, (options.jitter ?? 0) - fromMs, options.rename?.[i]),
    speaker: speaker(i),
  }));
  const segments: SttSegment[] = [];
  for (let k = 0; k < words.length; k += 5) {
    const group = words.slice(k, k + 5);
    segments.push({
      startMs: group[0]!.startMs,
      endMs: group.at(-1)!.endMs,
      text: group.map((w) => w.text).join(' '),
      speaker: group[0]!.speaker!,
    });
  }
  return {
    startMs: fromMs,
    seamStartMs: seams[0],
    seamEndMs: seams[1],
    result: {
      language: 'da',
      model: '@cf/openai/whisper-large-v3-turbo',
      segments,
      speakers: [...new Set(words.map((w) => w.speaker!))].map((index) => ({ index, label: null })),
      ...(options.words === false ? {} : { words }),
    },
  };
}

/** Every word index in the stitched text, in order. */
const said = (segments: readonly SttSegment[]) =>
  segments.flatMap((s) => s.text.split(' ')).map((w) => Number(w.replace(/\D/g, '')));
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('stitching pieces', () => {
  it('keeps every word once, in order, at its time in the original', () => {
    // Piece 1: 0 to 9 s, seam at 8 s. Piece 2: 7 to 17 s, seam at 16 s. Piece 3: 15 s to the end.
    const pieces = [
      piece(0, 9_000, [0, 8_000]),
      piece(7_000, 17_000, [8_000, 16_000]),
      piece(15_000, 24_000, [16_000, 24_000]),
    ];
    const result = stitch(pieces);
    expect(said(result.segments)).toEqual(range(0, 60));
    expect(result.words!.map((w) => w.text)).toEqual(range(0, 60).map((i) => `w${i}`));
    for (const w of result.words!) {
      const i = Number(w.text.slice(1));
      expect(w.startMs).toBe(i * 400);
    }
    for (let k = 1; k < result.segments.length; k++) {
      expect(result.segments[k]!.startMs).toBeGreaterThanOrEqual(result.segments[k - 1]!.startMs);
    }
    expect(result.raw).toEqual({ pieces: 3 });
    expect(result.language).toBe('da');
  });

  it('cuts inside the run both pieces heard, when their times drift apart', () => {
    // The second piece hears the overlap 250 ms later and one word differently.
    const result = stitch([
      piece(0, 9_000, [0, 8_000]),
      piece(7_000, 17_000, [8_000, 17_000], { jitter: 250, rename: { 18: 'w18x' } }),
    ]);
    const words = result.words!.map((w) => w.text);
    expect(new Set(words).size).toBe(words.length);
    expect(said(result.segments).filter((i) => i !== 18)).toEqual(
      range(0, 42).filter((i) => i !== 18),
    );
  });

  it('falls back to the seam when the pieces share no run of words', () => {
    const result = stitch([
      piece(0, 9_000, [0, 8_000]),
      piece(7_000, 17_000, [8_000, 17_000], {
        rename: { 17: 'a', 18: 'b', 19: 'c', 20: 'd', 21: 'e', 22: 'f' },
      }),
    ]);
    // Words before 8 s from the first piece, from 8 s on from the second.
    const texts = result.words!.map((w) => w.text);
    expect(texts.slice(0, 20)).toEqual(range(0, 20).map((i) => `w${i}`));
    expect(texts[20]).toBe('d');
    expect(texts).toHaveLength(42);
  });

  it('splits segment text over its span when the provider gave no words', () => {
    const result = stitch([
      piece(0, 9_000, [0, 8_000], { words: false }),
      piece(7_000, 17_000, [8_000, 17_000], { words: false }),
    ]);
    const indices = said(result.segments);
    expect(new Set(indices).size).toBe(indices.length);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(41);
  });

  it('rebuilds a segment the seam cuts, from the words it keeps', () => {
    const result = stitch([piece(0, 9_000, [0, 8_000]), piece(7_000, 17_000, [8_000, 17_000])]);
    for (const s of result.segments) {
      const [first, last] = [s.text.split(' ')[0]!, s.text.split(' ').at(-1)!];
      expect(s.startMs).toBe(Number(first.slice(1)) * 400);
      expect(s.endMs).toBe(Number(last.slice(1)) * 400 + 300);
    }
  });

  it('keeps speaker numbers across pieces: one speaker stays Speaker 1, two stay two', () => {
    const one = stitch([piece(0, 9_000, [0, 8_000]), piece(7_000, 17_000, [8_000, 17_000])]);
    expect(one.speakers).toEqual([{ index: 0, label: null }]);
    expect(new Set(one.segments.map((s) => s.speaker))).toEqual(new Set([0]));

    const turns = (i: number) => (Math.floor(i / 10) % 2 ? 1 : 0);
    const two = stitch([
      piece(0, 9_000, [0, 8_000], { speaker: turns }),
      piece(7_000, 17_000, [8_000, 17_000], { speaker: turns }),
    ]);
    expect(two.speakers.map((s) => s.index)).toEqual([0, 1]);
    for (const w of two.words!) expect(w.speaker).toBe(turns(Number(w.text.slice(1))));
  });

  it('rounds times moved by an offset that is not a whole millisecond, and ends at the recording', () => {
    // An Ogg page or AAC frame boundary: 883,015.6009 ms into the original.
    const a = piece(0, 9_000, [0, 8_000]);
    const b = { ...piece(7_000, 17_000, [8_000, 17_000]), startMs: 7_000.6009070295 };
    const result = stitch([a, b], 16_900);
    for (const s of result.segments) {
      expect(Number.isInteger(s.startMs) && Number.isInteger(s.endMs)).toBe(true);
      expect(s.endMs).toBeLessThanOrEqual(16_900);
    }
    for (const w of result.words!) expect(Number.isInteger(w.startMs)).toBe(true);
  });

  it('stitches one piece to itself and no pieces to nothing', () => {
    const only = piece(0, 4_000, [0, 4_000]);
    expect(said(stitch([only]).segments)).toEqual(range(0, 10));
    expect(stitch([])).toMatchObject({ segments: [], speakers: [], language: '' });
  });
});
