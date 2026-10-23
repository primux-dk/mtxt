/*
  Byte plumbing for the audio cutter (docs/decisions.md, packet 17): a
  reader that walks a stream front to back and buffers only what a parser
  asks for, and the few writers the containers need. Plain TypeScript with
  no Next.js imports: the queue consumer runs it.
*/

/** A container the cutter cannot read or cut safely. */
export class UnsupportedAudio extends Error {
  constructor(readonly detail: string) {
    super(`Audio cannot be cut: ${detail}`);
    this.name = 'UnsupportedAudio';
  }
}

/** Reads a stream in order, with the absolute position of the next byte. */
export class StreamReader {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private buffered = 0;
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(
    stream: ReadableStream<Uint8Array>,
    /** The position of the stream's first byte in the file. */
    public pos = 0,
  ) {
    this.reader = stream.getReader();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n && !this.ended) {
      const { value, done } = await this.reader.read();
      if (done) this.ended = true;
      else if (value.byteLength) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered >= n;
  }

  private take(n: number, consume: boolean): Uint8Array {
    const first = this.chunks[0]!;
    if (first.byteLength - this.offset >= n) {
      const out = first.subarray(this.offset, this.offset + n);
      if (consume) this.drop(n);
      return out;
    }
    const out = new Uint8Array(n);
    let at = 0;
    let i = 0;
    let offset = this.offset;
    while (at < n) {
      const chunk = this.chunks[i]!;
      const part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + n - at));
      out.set(part, at);
      at += part.byteLength;
      i++;
      offset = 0;
    }
    if (consume) this.drop(n);
    return out;
  }

  private drop(n: number) {
    this.buffered -= n;
    this.pos += n;
    while (n > 0) {
      const chunk = this.chunks[0]!;
      const left = chunk.byteLength - this.offset;
      if (n < left) {
        this.offset += n;
        return;
      }
      n -= left;
      this.chunks.shift();
      this.offset = 0;
    }
  }

  /** Exactly n bytes, or null at the end of the stream (nothing consumed). */
  async read(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    if (!(await this.fill(n))) return null;
    return this.take(n, true);
  }

  /** Up to n bytes without consuming them; fewer at the end of the stream. */
  async peek(n: number): Promise<Uint8Array> {
    await this.fill(n);
    return this.buffered ? this.take(Math.min(n, this.buffered), false) : new Uint8Array(0);
  }

  /** Skips up to n bytes; returns how many were skipped. */
  async skip(n: number): Promise<number> {
    let skipped = 0;
    while (skipped < n) {
      if (!this.buffered && !(await this.fill(1))) break;
      const step = Math.min(n - skipped, this.buffered);
      this.drop(step);
      skipped += step;
    }
    return skipped;
  }

  /** Moves forward to an absolute position at or after the current one. */
  async seek(pos: number): Promise<boolean> {
    if (pos < this.pos) throw new Error('StreamReader cannot go back');
    return (await this.skip(pos - this.pos)) === pos - this.pos;
  }

  async close() {
    await this.reader.cancel().catch(() => {});
  }
}

/** Opens the stored file, whole or from an offset. */
export type OpenAudio = (range?: {
  offset: number;
  length?: number;
}) => Promise<ReadableStream<Uint8Array>>;

/** Picks byte ranges, in ascending order, out of the file in one pass from the first. */
export async function pickRanges(
  open: OpenAudio,
  ranges: readonly { pos: number; len: number }[],
): Promise<Uint8Array[]> {
  if (!ranges.length) return [];
  const start = ranges[0]!.pos;
  const last = ranges.at(-1)!;
  const reader = new StreamReader(
    await open({ offset: start, length: last.pos + last.len - start }),
    start,
  );
  try {
    const out: Uint8Array[] = [];
    for (const range of ranges) {
      if (!(await reader.seek(range.pos))) throw new UnsupportedAudio('file ends early');
      const bytes = await reader.read(range.len);
      if (!bytes) throw new UnsupportedAudio('file ends early');
      // A subarray may share a buffer the reader reuses; a copy is the piece's own.
      out.push(bytes.slice());
    }
    return out;
  } finally {
    await reader.close();
  }
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

export const ascii = (bytes: Uint8Array, from = 0, length = 4) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

export const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
