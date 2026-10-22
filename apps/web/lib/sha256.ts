import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * SHA-256 that can be fed piece by piece, so a 2 GB file is hashed without
 * holding it in memory. Runs in the browser, where WebCrypto has no
 * incremental digest. Lowercase hex out, as the contract wants.
 */
export interface Sha256 {
  update(bytes: Uint8Array): Sha256;
  hex(): string;
}

export function createSha256(): Sha256 {
  const hash = sha256.create();
  const api: Sha256 = {
    update(bytes) {
      hash.update(bytes);
      return api;
    },
    hex: () => bytesToHex(hash.digest()),
  };
  return api;
}

/** Hashes a stream to the end. */
export async function sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createSha256();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return hash.hex();
    hash.update(value);
  }
}

/**
 * Hashes a Blob or File in slices of `sliceBytes`, reporting the bytes done.
 * Reading slice by slice keeps memory flat whatever the file size.
 */
export async function sha256OfBlob(
  blob: Blob,
  onProgress?: (doneBytes: number) => void,
  sliceBytes = 4 * 1024 * 1024,
): Promise<string> {
  const hash = createSha256();
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    const slice = blob.slice(offset, offset + sliceBytes);
    hash.update(new Uint8Array(await slice.arrayBuffer()));
    onProgress?.(Math.min(offset + sliceBytes, blob.size));
  }
  return hash.hex();
}
