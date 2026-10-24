import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPiece, planCut, sniff, UnsupportedAudio, type OpenAudio } from '../lib/audio';
import { oggCrc } from '../lib/audio/ogg';
import { planPieces, Units, type PieceLimits } from '../lib/audio/plan';

/*
  Packet 18: the cutter. The fixtures are 14 seconds of a 330 Hz tone that
  is silent from 6 to 7 s and from 13 to 14 s: chrome.webm was recorded by
  Chromium's own MediaRecorder (unknown-size Segment and Clusters, as the
  browser recorder sends), the rest made by ffmpeg. With ffmpeg on the PATH
  every piece is also decoded, and its length checked.
*/
const FIXTURES = join(__dirname, 'fixtures/audio');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const opener =
  (bytes: Uint8Array): OpenAudio =>
  async (range) =>
    new Blob(<BlobPart[]>[
      range
        ? bytes.subarray(
            range.offset,
            range.length === undefined ? undefined : range.offset + range.length,
          )
        : bytes,
    ]).stream();

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const scratch = mkdtempSync(join(tmpdir(), 'mtxt-cut-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Seconds of sound ffmpeg decodes from the bytes, at 8 kHz mono 16-bit. */
function decodedSeconds(bytes: Uint8Array, name: string) {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return pcm.byteLength / 16000;
}

/** A 16-bit mono WAV: a tone with silence from 6 to 7 s in every 7. */
function toneWav(seconds: number, rate = 8000) {
  const samples = seconds * rate;
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const v = t % 7 < 6 ? Math.sin(2 * Math.PI * 330 * t) * 8000 : 0;
    out.writeInt16LE(Math.round(v), 44 + i * 2);
  }
  return new Uint8Array(out);
}

const LIMITS: PieceLimits = { maxBytes: 1_000_000, maxMs: 8_000, overlapMs: 500, searchMs: 3_000 };

describe('the planner', () => {
  /** Units of 20 ms; `quiet` says which are silent. */
  const units = (ms: number, quiet: (t: number) => boolean, bytes = 100) => {
    const u = new Units();
    for (let t = 0; t < ms; t += 20) {
      u.push({ t, d: 20, pos: (t / 20) * bytes, len: bytes, level: quiet(t) ? 1 : 50 });
    }
    return u;
  };

  it('keeps a file that fits as one piece', () => {
    const pieces = planPieces(
      units(5_000, () => false),
      0,
      LIMITS,
    );
    expect(pieces).toEqual([
      { index: 0, first: 0, end: 250, startMs: 0, endMs: 5_000, seamStartMs: 0, seamEndMs: 5_000 },
    ]);
  });

  it('puts the seam in the silence, with the overlap on both sides, and covers the file', () => {
    const u = units(20_000, (t) => t % 7_000 >= 6_000);
    const pieces = planPieces(u, 0, LIMITS);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]!.seamEndMs).toBeGreaterThanOrEqual(6_000);
    expect(pieces[0]!.seamEndMs).toBeLessThan(7_000);
    for (let k = 0; k + 1 < pieces.length; k++) {
      const [a, b] = [pieces[k]!, pieces[k + 1]!];
      expect(a.endMs).toBeGreaterThanOrEqual(a.seamEndMs + LIMITS.overlapMs);
      expect(b.startMs).toBeLessThanOrEqual(a.seamEndMs - LIMITS.overlapMs);
      expect(b.seamStartMs).toBe(a.seamEndMs);
      expect(a.endMs - a.startMs).toBeLessThanOrEqual(LIMITS.maxMs);
    }
    expect(pieces[0]!.startMs).toBe(0);
    expect(pieces.at(-1)!.endMs).toBe(20_000);
    expect(pieces.at(-1)!.seamEndMs).toBe(20_000);
  });

  it('cuts at the latest point when nothing is quieter (a constant bitrate)', () => {
    const pieces = planPieces(
      units(20_000, () => false),
      0,
      LIMITS,
    );
    expect(pieces[0]!.seamEndMs).toBe(LIMITS.maxMs - LIMITS.overlapMs);
  });

  it('keeps every piece under the byte limit, header included', () => {
    const u = units(60_000, () => false, 400);
    const pieces = planPieces(u, 1_000, { ...LIMITS, maxBytes: 100_000, maxMs: 60_000 });
    for (const p of pieces) {
      const bytes = u.len.slice(p.first, p.end).reduce((n, b) => n + b, 0);
      expect(bytes + 1_000).toBeLessThanOrEqual(100_000);
    }
  });

  it('never starts a piece at a unit that continues the one before', () => {
    const u = new Units();
    for (let t = 0; t < 20_000; t += 1_000) {
      u.push({ t, d: 1_000, pos: t, len: 10, startable: (t / 1_000) % 3 === 0 });
    }
    const pieces = planPieces(u, 0, LIMITS);
    for (const p of pieces) expect(u.startable[p.first]).toBe(true);
  });

  it('refuses a unit larger than a piece, and limits with no room between the overlaps', () => {
    const u = new Units();
    u.push({ t: 0, d: 20, pos: 0, len: 10 });
    u.push({ t: 20, d: 20, pos: 10, len: 5_000_000 });
    expect(() => planPieces(u, 0, LIMITS)).toThrow(UnsupportedAudio);
    expect(() => planPieces(u, 0, { ...LIMITS, maxMs: 4_000 })).toThrow(/no room/);
  });
});

describe('cutting each container', () => {
  const cases = [
    { name: 'chrome.webm', format: 'webm', piece: 'webm', quiet: true },
    { name: 'tone.ogg', format: 'ogg', piece: 'ogg', quiet: true },
    { name: 'tone.mp3', format: 'mp3', piece: 'mp3', quiet: false },
    { name: 'tone.aac', format: 'adts', piece: 'adts', quiet: true },
    { name: 'tone.m4a', format: 'mp4', piece: 'adts', quiet: true },
    { name: 'tone.wav', format: 'wav', piece: 'wav', quiet: true },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: pieces that start at 0, cover the file and are files of their own`, async () => {
      const bytes = c.name === 'tone.wav' ? toneWav(14) : fixture(c.name);
      const open = opener(bytes);
      const plan = await planCut(open, bytes.byteLength, LIMITS);
      expect(plan.format).toBe(c.format);
      expect(plan.durationMs).toBeGreaterThan(13_500);
      expect(plan.pieces.length).toBeGreaterThan(1);
      // A codec that spends fewer bytes on silence, or PCM, gets its seam in the silence.
      if (c.quiet) {
        expect(plan.pieces[0]!.seamEndMs).toBeGreaterThanOrEqual(5_900);
        expect(plan.pieces[0]!.seamEndMs).toBeLessThanOrEqual(7_100);
      }
      // JSON as it stands, for the next delivery.
      expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);

      const cache = new Map<string, unknown>();
      for (const piece of plan.pieces) {
        const out = await buildPiece(plan, piece.index, open, cache);
        expect(sniff(out)).toBe(c.piece);
        // The piece read again is one piece, as long as the plan said, from its own 0.
        const again = await planCut(opener(out), out.byteLength, { ...LIMITS, maxMs: 60_000 });
        expect(again.pieces).toHaveLength(1);
        expect(Math.abs(again.durationMs - (piece.endMs - piece.startMs))).toBeLessThan(80);
        if (c.format === 'ogg') {
          // Every page's CRC holds, and only the last is end-of-stream.
          let at = 0;
          let pages = 0;
          let eos = 0;
          while (at < out.length) {
            const segments = out[at + 26]!;
            let size = 27 + segments;
            for (let i = 0; i < segments; i++) size += out[at + 27 + i]!;
            const page = out.slice(at, at + size);
            const crc = new DataView(page.buffer).getUint32(22, true);
            new DataView(page.buffer).setUint32(22, 0, true);
            expect(oggCrc(page)).toBe(crc);
            expect(new DataView(page.buffer).getUint32(18, true)).toBe(pages);
            if (page[5]! & 4) eos++;
            at += size;
            pages++;
          }
          expect(eos).toBe(1);
        }
        if (hasFfmpeg) {
          const seconds = decodedSeconds(out, `${c.name}.${piece.index}`);
          expect(Math.abs(seconds - (piece.endMs - piece.startMs) / 1000)).toBeLessThan(0.1);
        }
      }
    });
  }

  it('refuses FLAC and an unknown container, and a WAV that is not PCM', async () => {
    const flac = new TextEncoder().encode('fLaC\0\0\0\x22'.padEnd(64, '\0'));
    await expect(planCut(opener(flac), flac.length, LIMITS)).rejects.toThrow(UnsupportedAudio);
    const noise = new Uint8Array(4096).map((_, i) => (i * 37) % 251);
    await expect(planCut(opener(noise), noise.length, LIMITS)).rejects.toThrow(UnsupportedAudio);
    const adpcm = toneWav(2);
    new DataView(adpcm.buffer).setUint16(20, 2, true);
    await expect(planCut(opener(adpcm), adpcm.length, LIMITS)).rejects.toThrow(/WAV format 2/);
  });

  it('refuses an MP3 that loses its frame sync in the middle', async () => {
    const mp3 = fixture('tone.mp3');
    const broken = new Uint8Array(mp3.length + 70_000);
    broken.set(mp3.subarray(0, 20_000), 0);
    broken.set(mp3.subarray(20_000), 90_000);
    await expect(planCut(opener(broken), broken.length, LIMITS)).rejects.toThrow(/frame sync/);
  });
});
