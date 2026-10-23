/*
  Where to cut a recording into pieces (docs/decisions.md, packet 17). The
  container readers turn a file into units, the smallest pieces the
  container can be cut at without decoding: an Opus block, an Ogg page, an
  MP3 or AAC frame, a tenth of a second of PCM. The planner walks the
  units, fills each piece up to the byte and time limits, and puts the seam
  between two pieces at the quietest point near the end, judged by bytes
  per millisecond (a compressed codec spends fewer bits on silence) or, for
  PCM, by the samples themselves. Each piece reaches `overlapMs` past its
  seam and the next starts `overlapMs` before it, so a word cut at the seam
  is heard whole on one side; the stitcher keeps each word once.
*/
import { UnsupportedAudio } from './bytes';

/** The units of one file, in time order, as parallel arrays. */
export class Units {
  /** Start, in ms from the file's first unit. */
  readonly t: number[] = [];
  /** Duration in ms. */
  readonly d: number[] = [];
  /** Byte offset of the unit in the file. */
  readonly pos: number[] = [];
  /** Bytes the unit adds to a piece. */
  readonly len: number[] = [];
  /** Loudness, in any unit: only compared with other units of the same file. */
  readonly level: number[] = [];
  /** Whether a piece may start at this unit. */
  readonly startable: boolean[] = [];

  get length() {
    return this.t.length;
  }

  push(u: { t: number; d: number; pos: number; len: number; level?: number; startable?: boolean }) {
    this.t.push(u.t);
    this.d.push(u.d);
    this.pos.push(u.pos);
    this.len.push(u.len);
    this.level.push(u.level ?? (u.d > 0 ? u.len / u.d : 0));
    this.startable.push(u.startable ?? true);
  }

  end(i: number) {
    return this.t[i]! + this.d[i]!;
  }
}

export interface PieceLimits {
  /** The largest piece, in bytes as sent, headers included. */
  maxBytes: number;
  /** The longest piece, in ms. */
  maxMs: number;
  /** How far each piece reaches past its seam, in ms. */
  overlapMs: number;
  /** How far before the latest possible seam the planner looks for quiet, in ms. */
  searchMs: number;
}

export interface PlannedPiece {
  index: number;
  /** Units [first, end). */
  first: number;
  end: number;
  /** The piece's audio, in ms of the original. Its own time 0 is `startMs`. */
  startMs: number;
  endMs: number;
  /** The piece owns the words between its two seams (the file's start and end at the edges). */
  seamStartMs: number;
  seamEndMs: number;
}

/** Half the window over which loudness is averaged when the planner looks for quiet. */
const QUIET_HALF_WINDOW_MS = 400;

function lowerBound(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The pieces for a file. One piece when the whole file fits. A unit that
 * alone breaks a limit, or limits too tight to make progress, are refused.
 */
export function planPieces(
  units: Units,
  headerBytes: number,
  limits: PieceLimits,
): PlannedPiece[] {
  const n = units.length;
  if (!n) throw new UnsupportedAudio('no audio units');
  if (limits.maxMs <= 2 * limits.overlapMs + limits.searchMs) {
    throw new Error('Piece limits leave no room between the overlaps');
  }
  const { t, len, level, d, startable } = units;
  const bytes = [0];
  const loud = [0];
  const time = [0];
  for (let i = 0; i < n; i++) {
    bytes.push(bytes[i]! + len[i]!);
    loud.push(loud[i]! + level[i]! * d[i]!);
    time.push(time[i]! + d[i]!);
  }
  /** Time-weighted mean loudness of the units around `ms`. */
  const quiet = (ms: number) => {
    const a = lowerBound(t, ms - QUIET_HALF_WINDOW_MS);
    const b = Math.max(a + 1, lowerBound(t, ms + QUIET_HALF_WINDOW_MS));
    const span = time[b]! - time[a]!;
    return span > 0 ? (loud[b]! - loud[a]!) / span : 0;
  };

  const pieces: PlannedPiece[] = [];
  let s = 0;
  let seamStart = t[0]!;
  let e = 0;
  for (;;) {
    e = Math.max(e, s);
    while (
      e < n &&
      bytes[e + 1]! - bytes[s]! + headerBytes <= limits.maxBytes &&
      units.end(e) - t[s]! <= limits.maxMs
    ) {
      e++;
    }
    if (e === n) {
      pieces.push({
        index: pieces.length,
        first: s,
        end: n,
        startMs: t[s]!,
        endMs: units.end(n - 1),
        seamStartMs: seamStart,
        seamEndMs: units.end(n - 1),
      });
      return pieces;
    }
    if (e - s < 2) throw new UnsupportedAudio('a unit is larger than a piece');

    // The seam: the quietest unit start in the search window, the latest of equals.
    const hi = units.end(e - 1) - limits.overlapMs;
    const lo = Math.max(t[s]! + 2 * limits.overlapMs, hi - limits.searchMs);
    let seamUnit = -1;
    let best = Infinity;
    for (let c = lowerBound(t, lo); c < e && t[c]! <= hi; c++) {
      const q = quiet(t[c]!);
      if (q <= best) {
        best = q;
        seamUnit = c;
      }
    }
    if (seamUnit < 0) seamUnit = Math.max(s + 1, Math.min(e - 1, lowerBound(t, hi)));
    const seam = t[seamUnit]!;

    // This piece reaches overlapMs past the seam; the next starts overlapMs before it.
    const end = Math.min(e, Math.max(seamUnit + 1, lowerBound(t, seam + limits.overlapMs)));
    let next = Math.max(0, lowerBound(t, seam - limits.overlapMs + 1) - 1);
    while (next > s && !startable[next]) next--;
    if (next <= s) {
      next = s + 1;
      while (next < seamUnit && !startable[next]) next++;
    }
    pieces.push({
      index: pieces.length,
      first: s,
      end,
      startMs: t[s]!,
      endMs: units.end(end - 1),
      seamStartMs: seamStart,
      seamEndMs: seam,
    });
    s = next;
    seamStart = seam;
  }
}
