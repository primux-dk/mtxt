/*
  WebM and Matroska, what the browser recorder writes (Opus, a Segment and
  Clusters of unknown size, no Cues). The index walks the element tree and
  notes every block of the first audio track. A piece is a new file: the
  EBML header as it was, a Segment with a fresh Info (the timecode scale
  and the piece's own duration), Tracks with that one track, and the piece's blocks
  regrouped into new Clusters whose timecodes start at 0. Blocks are copied,
  never decoded; a BlockGroup's Block becomes a SimpleBlock.
*/
import {
  concat,
  fromBase64,
  StreamReader,
  toBase64,
  UnsupportedAudio,
  type OpenAudio,
} from './bytes';
import type { PlannedPiece } from './plan';
import { Units } from './plan';

export interface WebmMeta {
  /** The EBML header element, base64. */
  ebml: string;
  /** The audio TrackEntry element, base64. */
  track: string;
  trackNumber: number;
  /** Nanoseconds per timecode tick. */
  scale: number;
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;
/** Elements at the Segment's level: one of them ends a Cluster of unknown size. */
const LEVEL1 = new Set([
  ID.Cluster,
  ID.Info,
  ID.Tracks,
  0x114d9b74, // SeekHead
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

const vintLength = (first: number) => {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  return 0;
};

/** A vint in a byte array: its value (marker removed unless `keepMarker`) and length. */
function vint(bytes: Uint8Array, at: number, keepMarker = false) {
  const length = vintLength(bytes[at] ?? 0);
  if (!length || at + length > bytes.length) throw new UnsupportedAudio('bad EBML number');
  let value = keepMarker ? bytes[at]! : bytes[at]! & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}

function uint(bytes: Uint8Array) {
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

/** The children of a master element held in memory. */
function* children(body: Uint8Array) {
  let at = 0;
  while (at < body.length) {
    const id = vint(body, at, true);
    const size = vint(body, at + id.length);
    const start = at + id.length + size.length;
    const end = start + size.value;
    if (size.unknown || end > body.length) throw new UnsupportedAudio('bad EBML element');
    yield { id: id.value, body: body.subarray(start, end), whole: body.subarray(at, end) };
    at = end;
  }
}

async function readHead(reader: StreamReader) {
  const first = await reader.peek(1);
  if (!first.length) return null;
  const idLength = vintLength(first[0]!);
  if (!idLength || idLength > 4) throw new UnsupportedAudio('bad EBML id');
  const idBytes = await reader.peek(idLength + 8);
  if (idBytes.length <= idLength) return null;
  const id = vint(idBytes, 0, true);
  const sizeLength = vintLength(idBytes[idLength]!);
  if (!sizeLength || idBytes.length < idLength + sizeLength) return null;
  const size = vint(idBytes, idLength);
  const pos = reader.pos;
  await reader.skip(idLength + sizeLength);
  return {
    id: id.value,
    size: size.value,
    unknown: size.unknown,
    pos,
    headLength: idLength + sizeLength,
  };
}

/** A block's header: track number, timecode relative to its cluster, flags, header length. */
function blockHeader(body: Uint8Array) {
  const track = vint(body, 0);
  if (body.length < track.length + 3) throw new UnsupportedAudio('short block');
  const rel = new DataView(body.buffer, body.byteOffset + track.length, 2).getInt16(0);
  return { track: track.value, rel, flags: body[track.length + 2]!, length: track.length + 3 };
}

export async function indexWebm(open: OpenAudio) {
  const reader = new StreamReader(await open());
  let ebml: Uint8Array | null = null;
  let track: Uint8Array | null = null;
  let trackNumber = 0;
  let scale = 1_000_000;
  const raw: { tc: number; pos: number; len: number; cluster: number }[] = [];
  try {
    const head = await readHead(reader);
    if (!head || head.id !== ID.EBML || head.unknown) throw new UnsupportedAudio('not EBML');
    const body = await reader.read(head.size);
    if (!body) throw new UnsupportedAudio('short EBML header');
    // The header element again from its body: copied as the file has it.
    ebml = element(ID.EBML, body);
    const segment = await readHead(reader);
    if (!segment || segment.id !== ID.Segment) throw new UnsupportedAudio('no Segment');
    const segmentEnd = segment.unknown ? Infinity : reader.pos + segment.size;
    let cluster: number | null = null;
    let clusterEnd = Infinity;
    while (reader.pos < segmentEnd) {
      const el = await readHead(reader);
      if (!el) break;
      if (cluster !== null && (LEVEL1.has(el.id as never) || el.pos >= clusterEnd)) cluster = null;
      if (el.id === ID.Cluster) {
        cluster = 0;
        clusterEnd = el.unknown ? Infinity : reader.pos + el.size;
        continue; // its children follow
      }
      if (el.unknown) throw new UnsupportedAudio('an element of unknown size');
      if (el.id === ID.Info) {
        const info = await reader.read(el.size);
        if (!info) break;
        for (const c of children(info)) if (c.id === ID.TimecodeScale) scale = uint(c.body);
        continue;
      }
      if (el.id === ID.Tracks) {
        const tracks = await reader.read(el.size);
        if (!tracks) break;
        for (const entry of children(tracks)) {
          if (entry.id !== ID.TrackEntry || track) continue;
          let number = 0;
          let type = 0;
          for (const c of children(entry.body)) {
            if (c.id === ID.TrackNumber) number = uint(c.body);
            if (c.id === ID.TrackType) type = uint(c.body);
          }
          if (type === 2 && number) {
            track = entry.whole.slice();
            trackNumber = number;
          }
        }
        if (!track) throw new UnsupportedAudio('no audio track');
        continue;
      }
      if (cluster !== null && el.id === ID.Timecode) {
        const tc = await reader.read(el.size);
        if (!tc) break;
        cluster = uint(tc);
        continue;
      }
      if (cluster !== null && (el.id === ID.SimpleBlock || el.id === ID.BlockGroup)) {
        let header: Uint8Array | null;
        if (el.id === ID.SimpleBlock) {
          header = await reader.peek(Math.min(el.size, 12));
        } else {
          const group = await reader.peek(el.size);
          header = null;
          for (const c of children(group)) if (c.id === ID.Block) header = c.body;
        }
        const len = el.headLength + el.size;
        if ((await reader.skip(el.size)) < el.size) break; // a block cut short at the end
        if (!header) continue;
        const block = blockHeader(header);
        if (block.track !== trackNumber) continue;
        raw.push({ tc: cluster + block.rel, pos: el.pos, len, cluster });
        continue;
      }
      if ((await reader.skip(el.size)) < el.size) break;
    }
  } finally {
    await reader.close();
  }
  if (!track || !ebml) throw new UnsupportedAudio('no audio track');
  if (!raw.length) throw new UnsupportedAudio('no audio blocks');
  const ms = (tc: number) => (tc * scale) / 1e6;
  const units = new Units();
  const clusters: number[] = [];
  const t0 = raw[0]!.tc;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i]!;
    const next = raw[i + 1];
    const d = next ? Math.max(0, ms(next.tc - b.tc)) : i ? units.d[i - 1]! : 20;
    units.push({ t: ms(b.tc - t0), d, pos: b.pos, len: b.len });
    clusters.push(b.cluster);
  }
  return {
    units,
    clusters,
    headerBytes: ebml.byteLength + track.byteLength + 64,
    meta: {
      ebml: toBase64(ebml),
      track: toBase64(track),
      trackNumber,
      scale,
    } satisfies WebmMeta,
  };
}

/** The shortest vint for a size. */
function sizeVint(n: number): Uint8Array {
  let length = 1;
  while (n >= 2 ** (7 * length) - 1) length++;
  if (length > 8) throw new UnsupportedAudio('element too large');
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(out);
}

function uintBytes(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(out);
}

export function element(id: number, ...body: Uint8Array[]): Uint8Array {
  const content = concat(body);
  return concat([idBytes(id), sizeVint(content.byteLength), content]);
}

/** Timecode ticks a cluster spans at most before the next begins (a block's offset is an int16). */
const CLUSTER_SPAN = 30_000;

export async function buildWebm(
  meta: WebmMeta,
  piece: PlannedPiece & { byteStart: number; byteEnd: number; cluster: number },
  open: OpenAudio,
): Promise<Uint8Array> {
  const reader = new StreamReader(
    await open({ offset: piece.byteStart, length: piece.byteEnd - piece.byteStart }),
    piece.byteStart,
  );
  const blocks: { tc: number; flags: number; data: Uint8Array }[] = [];
  let cluster = piece.cluster;
  try {
    while (reader.pos < piece.byteEnd) {
      const el = await readHead(reader);
      if (!el) break;
      if (el.id === ID.Cluster) continue;
      if (el.unknown) throw new UnsupportedAudio('an element of unknown size');
      const body = await reader.read(el.size);
      if (!body) break;
      if (el.id === ID.Timecode) cluster = uint(body);
      let block: Uint8Array | null = null;
      let flags = 0;
      if (el.id === ID.SimpleBlock) {
        block = body;
      } else if (el.id === ID.BlockGroup) {
        for (const c of children(body)) if (c.id === ID.Block) block = c.body;
        flags = 0x80;
      }
      if (!block) continue;
      const header = blockHeader(block);
      if (header.track !== meta.trackNumber) continue;
      blocks.push({
        tc: cluster + header.rel,
        // Keyframe and lacing bits carry over; a BlockGroup's audio frame is a keyframe.
        flags: (el.id === ID.SimpleBlock ? header.flags : flags | (header.flags & 0x06)) & 0x8f,
        data: block.subarray(header.length).slice(),
      });
    }
  } finally {
    await reader.close();
  }
  if (!blocks.length) throw new UnsupportedAudio('an empty WebM piece');
  const base = blocks[0]!.tc;
  const track = sizeVint(meta.trackNumber);
  const clusters: Uint8Array[] = [];
  let start = 0;
  while (start < blocks.length) {
    const clusterTc = blocks[start]!.tc - base;
    let end = start;
    const parts: Uint8Array[] = [element(ID.Timecode, uintBytes(clusterTc))];
    while (end < blocks.length && blocks[end]!.tc - base - clusterTc <= CLUSTER_SPAN) {
      const b = blocks[end]!;
      const head = new Uint8Array(track.length + 3);
      head.set(track, 0);
      new DataView(head.buffer).setInt16(track.length, Math.max(0, b.tc - base - clusterTc));
      head[track.length + 2] = b.flags;
      parts.push(element(ID.SimpleBlock, head, b.data));
      end++;
    }
    clusters.push(element(ID.Cluster, ...parts));
    start = end;
  }
  // The duration in ticks, as a float: the last block's time plus one block, so a reader need not scan.
  const last = blocks.at(-1)!.tc - base;
  const step =
    blocks.length > 1 ? last - (blocks.at(-2)!.tc - base) : Math.round(20e6 / meta.scale);
  const duration = new Uint8Array(8);
  new DataView(duration.buffer).setFloat64(0, last + step);
  const info = element(
    ID.Info,
    element(ID.TimecodeScale, uintBytes(meta.scale)),
    element(ID.Duration, duration),
  );
  const tracks = element(ID.Tracks, fromBase64(meta.track));
  return concat([fromBase64(meta.ebml), element(ID.Segment, info, tracks, ...clusters)]);
}
