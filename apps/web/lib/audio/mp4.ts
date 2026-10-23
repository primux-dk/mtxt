/*
  MP4 and M4A with AAC: uploads, and the audio of a Teams or Meet video.
  The sample tables in `moov` say where every AAC frame sits in the file, so
  a piece is a run of frames read out by offset and written as ADTS, each
  frame behind a seven-byte header built from the track's
  AudioSpecificConfig. No new MP4 is written and nothing is decoded; video
  and other tracks between the frames are read past. Fragmented MP4, and
  audio that is not AAC (ALAC, Opus, MP3 in MP4), is not cut.
*/
import { ascii, pickRanges, UnsupportedAudio, view, type OpenAudio } from './bytes';
import { ADTS_RATE_INDEX } from './frames';
import type { PlannedPiece } from './plan';
import { Units } from './plan';

export interface Mp4Meta {
  moovPos: number;
  moovSize: number;
  /** Which `trak` in moov, counting from 0. */
  trak: number;
  /** ADTS fields. */
  profile: number;
  rateIndex: number;
  channels: number;
}

/** The largest moov read into memory: an hour of AAC needs about 1 MB of tables. */
const MAX_MOOV_BYTES = 48 * 1024 * 1024;

function* boxes(bytes: Uint8Array, from = 0, to = bytes.length) {
  let at = from;
  while (at + 8 <= to) {
    const v = view(bytes);
    let size = v.getUint32(at);
    const type = ascii(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      size = v.getUint32(at + 8) * 2 ** 32 + v.getUint32(at + 12);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new UnsupportedAudio('bad MP4 box');
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

const child = (bytes: Uint8Array, start: number, end: number, type: string) => {
  for (const b of boxes(bytes, start, end)) if (b.type === type) return b;
  return null;
};

/** Finds moov among the top-level boxes, by reading their headers only. */
async function findMoov(open: OpenAudio, size: number) {
  let at = 0;
  while (at + 8 <= size) {
    const head = await readAll(await open({ offset: at, length: Math.min(16, size - at) }));
    const v = view(head);
    let boxSize = v.getUint32(0);
    if (boxSize === 1 && head.length >= 16) boxSize = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
    else if (boxSize === 0) boxSize = size - at;
    const type = ascii(head, 4);
    if (boxSize < 8) throw new UnsupportedAudio('bad MP4 box');
    if (type === 'moof') throw new UnsupportedAudio('fragmented MP4');
    if (type === 'moov') return { pos: at, size: boxSize };
    at += boxSize;
  }
  throw new UnsupportedAudio('no moov box');
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function descriptorLength(bytes: Uint8Array, at: number) {
  let length = 0;
  let i = 0;
  for (; i < 4; i++) {
    const b = bytes[at + i]!;
    length = (length << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { length, size: i + 1 };
}

/** The AudioSpecificConfig out of an esds box body. */
function audioSpecificConfig(bytes: Uint8Array, start: number, end: number) {
  let at = start + 4; // version and flags
  const tag = (want: number) => {
    if (bytes[at] !== want) throw new UnsupportedAudio('bad esds');
    const { length, size } = descriptorLength(bytes, at + 1);
    at += 1 + size;
    return length;
  };
  tag(0x03);
  at += 2;
  const flags = bytes[at++]!;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + bytes[at]!;
  if (flags & 0x20) at += 2;
  tag(0x04);
  const objectType = bytes[at]!;
  // 0x40: MPEG-4 audio; 0x66 to 0x68: MPEG-2 AAC.
  if (objectType !== 0x40 && (objectType < 0x66 || objectType > 0x68)) {
    throw new UnsupportedAudio(`MP4 audio object type ${objectType}`);
  }
  at += 13;
  const length = tag(0x05);
  if (at + length > end) throw new UnsupportedAudio('bad esds');
  return bytes.subarray(at, at + length);
}

function adtsFields(asc: Uint8Array) {
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((asc[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return v;
  };
  const objectType = () => {
    const t = read(5);
    return t === 31 ? 32 + read(6) : t;
  };
  const rate = () => {
    const i = read(4);
    return i === 15 ? ADTS_RATE_INDEX(read(24)) : i;
  };
  let aot = objectType();
  const rateIndex = rate();
  const channels = read(4);
  // HE-AAC: the core is AAC LC at the core rate; a decoder finds SBR in the frames.
  if (aot === 5 || aot === 29) {
    rate();
    aot = objectType();
  }
  if (aot < 1 || aot > 4) throw new UnsupportedAudio(`AAC object type ${aot}`);
  if (rateIndex < 0 || rateIndex > 12) throw new UnsupportedAudio('AAC sample rate');
  if (channels < 1 || channels > 7) throw new UnsupportedAudio('AAC channel layout');
  return { profile: aot - 1, rateIndex, channels };
}

interface Table {
  offsets: number[];
  sizes: number[];
  times: number[];
  durations: number[];
  timescale: number;
}

/** The audio track's samples: offset, size and time of each, from stbl. */
function sampleTable(moov: Uint8Array, trakIndex?: number) {
  let index = -1;
  // The moov box itself: an eight-byte header, or sixteen with a 64-bit size.
  for (const trak of boxes(moov, view(moov).getUint32(0) === 1 ? 16 : 8)) {
    if (trak.type !== 'trak') continue;
    index++;
    if (trakIndex !== undefined && index !== trakIndex) continue;
    const mdia = child(moov, trak.start, trak.end, 'mdia');
    const hdlr = mdia && child(moov, mdia.start, mdia.end, 'hdlr');
    if (!mdia || !hdlr || ascii(moov, hdlr.start + 8) !== 'soun') continue;
    const mdhd = child(moov, mdia.start, mdia.end, 'mdhd')!;
    const mv = view(moov);
    const timescale = mv.getUint32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
    const minf = child(moov, mdia.start, mdia.end, 'minf');
    const stbl = minf && child(moov, minf.start, minf.end, 'stbl');
    if (!stbl) continue;
    const box = (type: string) => child(moov, stbl.start, stbl.end, type);
    const stsd = box('stsd');
    if (!stsd) continue;
    const entry = [...boxes(moov, stsd.start + 8, stsd.end)][0];
    if (!entry || entry.type !== 'mp4a') throw new UnsupportedAudio(`MP4 audio ${entry?.type}`);
    // An audio sample entry: 28 bytes, 16 more for QuickTime version 1, 36 for version 2.
    const version = mv.getUint16(entry.start + 8);
    const esds = child(
      moov,
      entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0),
      entry.end,
      'esds',
    );
    if (!esds) throw new UnsupportedAudio('MP4 audio without esds');
    const fields = adtsFields(audioSpecificConfig(moov, esds.start, esds.end));

    const stsz = box('stsz');
    const stco = box('stco') ?? box('co64');
    const stsc = box('stsc');
    const stts = box('stts');
    if (!stsz || !stco || !stsc || !stts) throw new UnsupportedAudio('MP4 sample table incomplete');
    const fixed = mv.getUint32(stsz.start + 4);
    const count = mv.getUint32(stsz.start + 8);
    if (!count) throw new UnsupportedAudio('fragmented MP4');
    const sizes: number[] = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || mv.getUint32(stsz.start + 12 + 4 * i);

    const wide = ascii(moov, stco.start - 4) === 'co64';
    const chunkCount = mv.getUint32(stco.start + 4);
    const chunkOffset = (c: number) =>
      wide
        ? mv.getUint32(stco.start + 8 + 8 * c) * 2 ** 32 + mv.getUint32(stco.start + 12 + 8 * c)
        : mv.getUint32(stco.start + 8 + 4 * c);
    const runs = mv.getUint32(stsc.start + 4);
    const offsets: number[] = new Array(count);
    let sample = 0;
    for (let r = 0; r < runs && sample < count; r++) {
      const at = stsc.start + 8 + 12 * r;
      const firstChunk = mv.getUint32(at) - 1;
      const perChunk = mv.getUint32(at + 4);
      const lastChunk = r + 1 < runs ? mv.getUint32(at + 12) - 1 : chunkCount;
      for (let c = firstChunk; c < lastChunk && sample < count; c++) {
        let offset = chunkOffset(c);
        for (let k = 0; k < perChunk && sample < count; k++) {
          offsets[sample] = offset;
          offset += sizes[sample]!;
          sample++;
        }
      }
    }
    if (sample < count) throw new UnsupportedAudio('MP4 sample table incomplete');

    const times: number[] = new Array(count);
    const durations: number[] = new Array(count);
    let time = 0;
    sample = 0;
    const entries = mv.getUint32(stts.start + 4);
    for (let e = 0; e < entries && sample < count; e++) {
      const n = mv.getUint32(stts.start + 8 + 8 * e);
      const delta = mv.getUint32(stts.start + 12 + 8 * e);
      for (let k = 0; k < n && sample < count; k++) {
        times[sample] = time;
        durations[sample] = delta;
        time += delta;
        sample++;
      }
    }
    for (; sample < count; sample++) {
      times[sample] = time;
      durations[sample] = 1024;
      time += 1024;
    }
    for (let i = 1; i < count; i++) {
      if (offsets[i]! < offsets[i - 1]! + sizes[i - 1]!) {
        throw new UnsupportedAudio('MP4 samples out of order');
      }
    }
    return {
      trak: index,
      fields,
      table: { offsets, sizes, times, durations, timescale } satisfies Table,
    };
  }
  throw new UnsupportedAudio('MP4 without an audio track');
}

async function readMoov(open: OpenAudio, pos: number, size: number) {
  if (size > MAX_MOOV_BYTES) throw new UnsupportedAudio('MP4 moov too large');
  return readAll(await open({ offset: pos, length: size }));
}

export async function indexMp4(open: OpenAudio, size: number) {
  const moov = await findMoov(open, size);
  const { trak, fields, table } = sampleTable(await readMoov(open, moov.pos, moov.size));
  const units = new Units();
  const ms = (v: number) => (v * 1000) / table.timescale;
  for (let i = 0; i < table.offsets.length; i++) {
    units.push({
      t: ms(table.times[i]!),
      d: ms(table.durations[i]!),
      pos: table.offsets[i]!,
      len: table.sizes[i]! + 7,
    });
  }
  return {
    units,
    headerBytes: 0,
    meta: { moovPos: moov.pos, moovSize: moov.size, trak, ...fields } satisfies Mp4Meta,
  };
}

export function adtsHeader(
  meta: Pick<Mp4Meta, 'profile' | 'rateIndex' | 'channels'>,
  payload: number,
) {
  const len = payload + 7;
  return Uint8Array.from([
    0xff,
    0xf1,
    (meta.profile << 6) | (meta.rateIndex << 2) | (meta.channels >> 2),
    ((meta.channels & 3) << 6) | (len >> 11),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ]);
}

/** The piece as ADTS: every frame in [first, end) behind its header. */
export async function buildMp4(
  meta: Mp4Meta,
  piece: PlannedPiece,
  open: OpenAudio,
  cache?: Map<string, unknown>,
): Promise<Uint8Array> {
  const key = `mp4:${meta.moovPos}:${meta.moovSize}`;
  let table = cache?.get(key) as Table | undefined;
  if (!table) {
    table = sampleTable(await readMoov(open, meta.moovPos, meta.moovSize), meta.trak).table;
    cache?.set(key, table);
  }
  const ranges: { pos: number; len: number }[] = [];
  for (let i = piece.first; i < piece.end; i++) {
    ranges.push({ pos: table.offsets[i]!, len: table.sizes[i]! });
  }
  const frames = await pickRanges(open, ranges);
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength + 7, 0));
  let at = 0;
  for (const frame of frames) {
    out.set(adtsHeader(meta, frame.byteLength), at);
    out.set(frame, at + 7);
    at += frame.byteLength + 7;
  }
  return out;
}
