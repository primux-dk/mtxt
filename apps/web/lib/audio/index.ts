/*
  The audio cutter (docs/decisions.md, packet 17): reads a stored
  recording's container, plans pieces under the provider's limits, and
  builds one piece at a time as a file of its own, without decoding a
  sample. The container is told by its first bytes, not by the MIME type a
  client sent. FLAC, and anything not listed below, is not cut.

    WebM / Matroska  re-muxed: the header, the audio track, the piece's blocks in new clusters
    Ogg Opus         the header pages, then the piece's pages with granules moved to 0
    MP3, ADTS AAC    a run of whole frames, copied
    MP4 / M4A (AAC)  the piece's frames written as ADTS
    WAV (PCM)        a new header and a run of whole sample frames
*/
import { concat, pickRanges, UnsupportedAudio, type OpenAudio } from './bytes';
import { indexFrames } from './frames';
import { buildMp4, indexMp4, type Mp4Meta } from './mp4';
import { buildOgg, indexOgg, type OggMeta } from './ogg';
import { planPieces, type PieceLimits, type PlannedPiece, type Units } from './plan';
import { indexWav, wavHeader, type WavMeta } from './wav';
import { buildWebm, indexWebm, type WebmMeta } from './webm';

export { UnsupportedAudio, type OpenAudio } from './bytes';
export type { PieceLimits, PlannedPiece } from './plan';

export type AudioFormat = 'webm' | 'ogg' | 'mp3' | 'adts' | 'mp4' | 'wav';

/** What a piece of each format is sent as. */
export const PIECE_CONTENT_TYPE: Record<AudioFormat, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  adts: 'audio/aac',
  mp4: 'audio/aac',
  wav: 'audio/wav',
};

export interface PieceSpec extends PlannedPiece {
  /** The bytes of the original the piece is read from. */
  byteStart: number;
  byteEnd: number;
  /** WebM: the timecode of the cluster the first block sits in. Ogg: the granule before the first page. */
  base: number;
}

/** Everything needed to build any piece later, in another delivery: JSON as it stands. */
export interface CutPlan {
  version: 1;
  format: AudioFormat;
  contentType: string;
  sizeBytes: number;
  durationMs: number;
  meta: WebmMeta | OggMeta | Mp4Meta | WavMeta | Record<string, never>;
  pieces: PieceSpec[];
}

/** The container from the first bytes of the file, or null for one the cutter does not take. */
export function sniff(head: Uint8Array): AudioFormat | null {
  const text = (from: number, n: number) => String.fromCharCode(...head.subarray(from, from + n));
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (text(0, 4) === 'OggS') return 'ogg';
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return 'wav';
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(text(4, 4))) return 'mp4';
  if (text(0, 3) === 'ID3') return 'mp3';
  if (head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return 'adts';
  if (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return 'mp3';
  return null;
}

async function index(format: AudioFormat, open: OpenAudio, size: number) {
  switch (format) {
    case 'webm': {
      const r = await indexWebm(open);
      return { ...r, base: r.clusters };
    }
    case 'ogg': {
      const r = await indexOgg(open);
      return { ...r, base: r.before };
    }
    case 'mp3':
    case 'adts':
      return { ...(await indexFrames(open, format)), base: null };
    case 'mp4':
      return { ...(await indexMp4(open, size)), base: null };
    case 'wav':
      return { ...(await indexWav(open, size)), base: null };
  }
}

/** Reads the file once and plans its pieces. Throws UnsupportedAudio for a file it cannot cut. */
export async function planCut(open: OpenAudio, size: number, limits: PieceLimits): Promise<CutPlan> {
  const head = new Uint8Array(await new Response(await open({ offset: 0, length: 64 })).arrayBuffer());
  const format = sniff(head);
  if (!format) throw new UnsupportedAudio('unknown container');
  const { units, headerBytes, meta, base } = await index(format, open, size);
  // An MP4 unit counts the ADTS header it gains; its bytes in the file are seven fewer.
  const gained = format === 'mp4' ? 7 : 0;
  const pieces = planPieces(units, headerBytes, limits).map((p) => spec(units, p, base, gained));
  return {
    version: 1,
    format,
    contentType: PIECE_CONTENT_TYPE[format],
    sizeBytes: size,
    durationMs: units.end(units.length - 1),
    meta,
    pieces,
  };
}

function spec(units: Units, piece: PlannedPiece, base: number[] | null, gained: number): PieceSpec {
  return {
    ...piece,
    byteStart: units.pos[piece.first]!,
    byteEnd: units.pos[piece.end - 1]! + units.len[piece.end - 1]! - gained,
    base: base ? base[piece.first]! : 0,
  };
}

/** One piece as a file of its own. `cache` keeps parsed tables between pieces of one delivery. */
export async function buildPiece(
  plan: CutPlan,
  index: number,
  open: OpenAudio,
  cache?: Map<string, unknown>,
): Promise<Uint8Array> {
  const piece = plan.pieces[index];
  if (!piece) throw new Error(`No piece ${index}`);
  switch (plan.format) {
    case 'webm':
      return buildWebm(plan.meta as WebmMeta, { ...piece, cluster: piece.base }, open);
    case 'ogg':
      return buildOgg(plan.meta as OggMeta, piece, open);
    case 'mp4':
      return buildMp4(plan.meta as Mp4Meta, piece, open, cache);
    case 'mp3':
    case 'adts': {
      const [bytes] = await pickRanges(open, [{ pos: piece.byteStart, len: piece.byteEnd - piece.byteStart }]);
      return bytes!;
    }
    case 'wav': {
      const length = piece.byteEnd - piece.byteStart;
      const [bytes] = await pickRanges(open, [{ pos: piece.byteStart, len: length }]);
      return concat([wavHeader(plan.meta as WavMeta, length), bytes!]);
    }
  }
}
