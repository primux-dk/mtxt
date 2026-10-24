/*
  MP3 and raw AAC (ADTS): self-delimiting frames, each with its own header,
  so a piece is a run of whole frames copied as they are. An MP3 frame may
  borrow bits from the frames before it (the bit reservoir); a piece that
  starts without them loses at most one frame's sound, well inside the
  overlap. Leading ID3v2 tags and the Xing/Info frame are left out of every
  piece; a trailing ID3v1 tag ends the scan, and 64 KiB without a frame
  header refuses the file.
*/
import { ascii, StreamReader, UnsupportedAudio, type OpenAudio } from './bytes';
import { Units } from './plan';

const MP3_BITRATES: Record<string, number[]> = {
  // [version 1 | 2/2.5][layer 1 | 2 | 3], kbps by index 1..14
  '1-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = [
  [11025, 12000, 8000], // 2.5
  [],
  [22050, 24000, 16000], // 2
  [44100, 48000, 32000], // 1
];
const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** One MP3 frame header: its length in bytes and its duration in samples, or null. */
export function mp3Frame(h: Uint8Array): { len: number; samples: number; rate: number } | null {
  if (h.byteLength < 4 || h[0] !== 0xff || (h[1]! & 0xe0) !== 0xe0) return null;
  const version = (h[1]! >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
  const layer = 4 - ((h[1]! >> 1) & 3); // 1, 2, 3
  const bitrateIndex = h[2]! >> 4;
  const rateIndex = (h[2]! >> 2) & 3;
  const padding = (h[2]! >> 1) & 1;
  if (
    version === 1 ||
    layer === 4 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    rateIndex === 3
  ) {
    return null;
  }
  const kbps = MP3_BITRATES[`${version === 3 ? 1 : 2}-${layer}`]![bitrateIndex - 1]!;
  const rate = MP3_RATES[version]![rateIndex]!;
  const bitrate = kbps * 1000;
  if (layer === 1)
    return { len: (Math.floor((12 * bitrate) / rate) + padding) * 4, samples: 384, rate };
  const samples = layer === 3 && version !== 3 ? 576 : 1152;
  return { len: Math.floor(((samples / 8) * bitrate) / rate) + padding, samples, rate };
}

/** One ADTS header: the frame's length and its samples, or null. */
export function adtsFrame(h: Uint8Array): { len: number; samples: number; rate: number } | null {
  if (h.byteLength < 7 || h[0] !== 0xff || (h[1]! & 0xf6) !== 0xf0) return null;
  const rate = ADTS_RATES[(h[2]! >> 2) & 0xf];
  const len = ((h[3]! & 3) << 11) | (h[4]! << 3) | (h[5]! >> 5);
  const blocks = (h[6]! & 3) + 1;
  if (!rate || len < 7) return null;
  return { len, samples: 1024 * blocks, rate };
}

export const ADTS_RATE_INDEX = (rate: number) => ADTS_RATES.indexOf(rate);

/** How far the scanner looks for the next frame after a bad header. */
const RESYNC_BYTES = 64 * 1024;

export async function indexFrames(open: OpenAudio, kind: 'mp3' | 'adts') {
  const reader = new StreamReader(await open());
  const parse = kind === 'mp3' ? mp3Frame : adtsFrame;
  const units = new Units();
  try {
    // ID3v2 at the start: a ten-byte header with a syncsafe size.
    const head = await reader.peek(10);
    if (head.byteLength === 10 && ascii(head, 0, 3) === 'ID3') {
      const size =
        ((head[6]! & 0x7f) << 21) |
        ((head[7]! & 0x7f) << 14) |
        ((head[8]! & 0x7f) << 7) |
        (head[9]! & 0x7f);
      await reader.skip(10 + size + (head[5]! & 0x10 ? 10 : 0));
    }
    let samples = 0;
    let rate = 0;
    let lost = 0;
    let first = true;
    for (;;) {
      const h = await reader.peek(kind === 'mp3' ? 4 : 7);
      if (h.byteLength < 4) break;
      if (ascii(h, 0, 3) === 'TAG') break;
      const frame = parse(h);
      if (!frame) {
        // Lost in the middle: a transcript that stops here would look whole, so refuse instead.
        if (++lost > RESYNC_BYTES) throw new UnsupportedAudio(`lost ${kind} frame sync`);
        await reader.skip(1);
        continue;
      }
      if (rate && frame.rate !== rate) throw new UnsupportedAudio('sample rate changes mid-file');
      rate = frame.rate;
      lost = 0;
      const pos = reader.pos;
      const bytes = await reader.read(frame.len);
      if (!bytes) break; // a frame cut short at the end
      // The Xing/Info frame carries no sound: it describes the whole file, so no piece gets it.
      if (first && kind === 'mp3') {
        first = false;
        const text = ascii(bytes, 0, Math.min(64, bytes.byteLength));
        if (text.includes('Xing') || text.includes('Info')) continue;
      }
      first = false;
      units.push({
        t: (samples * 1000) / rate,
        d: (frame.samples * 1000) / rate,
        pos,
        len: frame.len,
      });
      samples += frame.samples;
    }
  } finally {
    await reader.close();
  }
  if (!units.length) throw new UnsupportedAudio(`no ${kind} frames`);
  return { units, headerBytes: 0, meta: {} };
}
