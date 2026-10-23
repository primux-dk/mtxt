/*
  WAV: PCM after a RIFF header. A piece is a new 44-byte header and a run of
  whole sample frames. Units are tenths of a second; for 16-bit PCM their
  loudness is the mean absolute value of every eighth sample, so the seam
  lands in real silence. Other sample formats are cut on fixed boundaries.
*/
import { ascii, StreamReader, UnsupportedAudio, view, type OpenAudio } from './bytes';
import type { PlannedPiece } from './plan';
import { Units } from './plan';

export interface WavMeta {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataStart: number;
}

const UNIT_MS = 100;

export async function indexWav(open: OpenAudio, size: number) {
  const reader = new StreamReader(await open());
  try {
    const riff = await reader.read(12);
    if (!riff || ascii(riff) !== 'RIFF' || ascii(riff, 8) !== 'WAVE') {
      throw new UnsupportedAudio('not a RIFF WAVE file');
    }
    let fmt: Omit<WavMeta, 'dataStart'> | null = null;
    for (;;) {
      const header = await reader.read(8);
      if (!header) throw new UnsupportedAudio('no data chunk');
      const id = ascii(header);
      const chunkSize = view(header).getUint32(4, true);
      if (id === 'fmt ') {
        const body = await reader.read(chunkSize);
        if (!body || chunkSize < 16) throw new UnsupportedAudio('short fmt chunk');
        const v = view(body);
        let format = v.getUint16(0, true);
        // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes are the format code.
        if (format === 0xfffe && chunkSize >= 26) format = v.getUint16(24, true);
        fmt = {
          format,
          channels: v.getUint16(2, true),
          sampleRate: v.getUint32(4, true),
          blockAlign: v.getUint16(12, true),
          bitsPerSample: v.getUint16(14, true),
        };
        if (chunkSize % 2) await reader.skip(1);
        continue;
      }
      if (id !== 'data') {
        await reader.skip(chunkSize + (chunkSize % 2));
        continue;
      }
      if (!fmt) throw new UnsupportedAudio('data before fmt');
      // PCM (1) and IEEE float (3) are cut by frames; anything compressed is not.
      if ((fmt.format !== 1 && fmt.format !== 3) || !fmt.blockAlign || !fmt.sampleRate) {
        throw new UnsupportedAudio(`WAV format ${fmt.format}`);
      }
      const dataStart = reader.pos;
      // A streamed WAV may say 0 or 0xFFFFFFFF; the file's own end is the bound.
      const declared = chunkSize && chunkSize !== 0xffffffff ? chunkSize : size - dataStart;
      const dataBytes = Math.min(declared, size - dataStart);
      const frames = Math.floor(dataBytes / fmt.blockAlign);
      const unitFrames = Math.max(1, Math.round((fmt.sampleRate * UNIT_MS) / 1000));
      const units = new Units();
      const pcm16 = fmt.format === 1 && fmt.bitsPerSample === 16;
      for (let f = 0; f < frames; f += unitFrames) {
        const count = Math.min(unitFrames, frames - f);
        const len = count * fmt.blockAlign;
        let level = 1;
        if (pcm16) {
          const block = await reader.read(len);
          if (!block) break;
          const v = view(block);
          let sum = 0;
          let k = 0;
          for (let at = 0; at + 1 < block.byteLength; at += fmt.blockAlign * 8) {
            sum += Math.abs(v.getInt16(at, true));
            k++;
          }
          level = k ? sum / k : 0;
        } else if ((await reader.skip(len)) < len) break;
        units.push({
          t: (f * 1000) / fmt.sampleRate,
          d: (count * 1000) / fmt.sampleRate,
          pos: dataStart + f * fmt.blockAlign,
          len,
          level,
        });
      }
      return { units, headerBytes: 44, meta: { ...fmt, dataStart } satisfies WavMeta };
    }
  } finally {
    await reader.close();
  }
}

export function wavHeader(meta: WavMeta, dataBytes: number): Uint8Array {
  const out = new Uint8Array(44);
  const v = view(out);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  v.setUint32(4, 36 + dataBytes, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt
  v.setUint32(16, 16, true);
  v.setUint16(20, meta.format, true);
  v.setUint16(22, meta.channels, true);
  v.setUint32(24, meta.sampleRate, true);
  v.setUint32(28, meta.sampleRate * meta.blockAlign, true);
  v.setUint16(32, meta.blockAlign, true);
  v.setUint16(34, meta.bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // data
  v.setUint32(40, dataBytes, true);
  return out;
}

export function wavPieceHeader(meta: WavMeta, piece: PlannedPiece & { byteStart: number; byteEnd: number }) {
  return wavHeader(meta, piece.byteEnd - piece.byteStart);
}
