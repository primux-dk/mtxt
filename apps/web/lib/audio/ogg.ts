/*
  Ogg Opus, what the desktop recorder writes: a page stream whose first
  pages hold OpusHead and OpusTags (granule 0), then audio pages, each
  carrying the sample count at its last packet's end. A piece is the
  header pages as they are, then a run of whole audio pages renumbered from
  there, their granules moved so the piece starts at 0, the last marked
  end-of-stream, every CRC computed again. A page that continues a packet
  from the page before is never a piece's first. One logical stream only.
*/
import { ascii, concat, fromBase64, StreamReader, toBase64, UnsupportedAudio, view, type OpenAudio } from './bytes';
import type { PlannedPiece } from './plan';
import { Units } from './plan';

export interface OggMeta {
  /** The header pages (OpusHead, OpusTags), base64. */
  header: string;
  headerPages: number;
  preSkip: number;
}

const NO_GRANULE = -1;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  }
  return crc;
}

interface Page {
  pos: number;
  bytes: Uint8Array;
  type: number;
  granule: number;
  serial: number;
  bodyStart: number;
}

const readGranule = (v: DataView) => {
  const lo = v.getUint32(6, true);
  const hi = v.getUint32(10, true);
  return lo === 0xffffffff && hi === 0xffffffff ? NO_GRANULE : hi * 2 ** 32 + lo;
};

async function nextPage(reader: StreamReader): Promise<Page | null> {
  const pos = reader.pos;
  const head = await reader.peek(27);
  if (head.byteLength < 27) return null;
  if (ascii(head) !== 'OggS' || head[4] !== 0) throw new UnsupportedAudio('Ogg page sync lost');
  const segments = head[26]!;
  const lacing = await reader.peek(27 + segments);
  if (lacing.byteLength < 27 + segments) return null;
  let body = 0;
  for (let i = 0; i < segments; i++) body += lacing[27 + i]!;
  const bytes = await reader.read(27 + segments + body);
  if (!bytes) return null; // a page cut short at the end
  const v = view(bytes);
  return {
    pos,
    bytes,
    type: bytes[5]!,
    granule: readGranule(v),
    serial: v.getUint32(14, true),
    bodyStart: 27 + segments,
  };
}

export async function indexOgg(open: OpenAudio) {
  const reader = new StreamReader(await open());
  const units = new Units();
  /** The granule before each unit's page: where a piece starting there begins. */
  const before: number[] = [];
  const header: Uint8Array[] = [];
  let preSkip = 0;
  let serial: number | null = null;
  try {
    let previous = 0;
    let audio = false;
    for (;;) {
      const page = await nextPage(reader);
      if (!page) break;
      if (serial === null) {
        if (ascii(page.bytes, page.bodyStart, 8) !== 'OpusHead') {
          throw new UnsupportedAudio('Ogg without Opus');
        }
        serial = page.serial;
        preSkip = view(page.bytes).getUint16(page.bodyStart + 10, true);
        // The first piece keeps the file's own granules: its base is the encoder's pre-skip.
        previous = preSkip;
      } else if (page.serial !== serial) {
        throw new UnsupportedAudio('Ogg with more than one stream');
      }
      if (!audio && page.granule === 0) {
        header.push(page.bytes);
        continue;
      }
      audio = true;
      const known = page.granule !== NO_GRANULE;
      const start = Math.max(0, previous - preSkip);
      const end = known ? Math.max(start, page.granule - preSkip) : start;
      units.push({
        t: start / 48,
        d: (end - start) / 48,
        pos: page.pos,
        len: page.bytes.byteLength,
        // A page that ends no packet, or continues one, is no place to start.
        startable: known && !(page.type & 1),
        level: end > start ? page.bytes.byteLength / ((end - start) / 48) : 0,
      });
      before.push(previous);
      if (known) previous = page.granule;
    }
  } finally {
    await reader.close();
  }
  if (!units.length) throw new UnsupportedAudio('no Ogg audio pages');
  const head = concat(header);
  return {
    units,
    before,
    headerBytes: head.byteLength,
    meta: { header: toBase64(head), headerPages: header.length, preSkip } satisfies OggMeta,
  };
}

/** The piece's bytes: header pages, then its pages renumbered and moved to start at 0. */
export async function buildOgg(
  meta: OggMeta,
  piece: PlannedPiece & { byteStart: number; byteEnd: number; base: number },
  open: OpenAudio,
): Promise<Uint8Array> {
  const reader = new StreamReader(
    await open({ offset: piece.byteStart, length: piece.byteEnd - piece.byteStart }),
    piece.byteStart,
  );
  const pages: Uint8Array[] = [];
  try {
    for (;;) {
      const page = await nextPage(reader);
      if (!page) break;
      const bytes = page.bytes.slice();
      const v = view(bytes);
      if (page.granule !== NO_GRANULE) {
        const moved = page.granule - piece.base + meta.preSkip;
        v.setUint32(6, moved % 2 ** 32, true);
        v.setUint32(10, Math.floor(moved / 2 ** 32), true);
      }
      v.setUint32(18, meta.headerPages + pages.length, true);
      bytes[5] = bytes[5]! & ~0x06; // not BOS, not EOS yet
      pages.push(bytes);
    }
  } finally {
    await reader.close();
  }
  if (!pages.length) throw new UnsupportedAudio('an empty Ogg piece');
  const last = pages.at(-1)!;
  last[5] = last[5]! | 0x04;
  for (const page of pages) {
    const v = view(page);
    v.setUint32(22, 0, true);
    v.setUint32(22, oggCrc(page), true);
  }
  return concat([fromBase64(meta.header), ...pages]);
}
