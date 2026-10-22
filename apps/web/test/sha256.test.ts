import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSha256, sha256OfBlob, sha256OfStream } from '../lib/sha256';

const node = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('sha256 streaming helper', () => {
  const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17));

  it('matches a one-shot hash whatever the piece boundaries', () => {
    const hash = createSha256();
    for (let at = 0; at < data.length; at += 999_983) hash.update(data.subarray(at, at + 999_983));
    expect(hash.hex()).toBe(node(data));
  });

  it('hashes a stream and a Blob, reporting progress to the end', async () => {
    const stream = new Blob([data]).stream();
    expect(await sha256OfStream(stream)).toBe(node(data));
    const seen: number[] = [];
    expect(await sha256OfBlob(new Blob([data]), (done) => seen.push(done), 1024 * 1024)).toBe(
      node(data),
    );
    expect(seen.at(-1)).toBe(data.length);
    expect(seen).toHaveLength(4);
  });

  it('hashes nothing to the empty digest', async () => {
    expect(createSha256().hex()).toBe(node(new Uint8Array()));
    expect(await sha256OfBlob(new Blob([]))).toBe(node(new Uint8Array()));
  });
});
