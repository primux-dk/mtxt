/**
 * Where audio and exports live. Cloudflare binds R2; a Docker edition binds an
 * S3-compatible store behind the same interface.
 */
export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  uploadedAt?: Date;
  customMetadata?: Record<string, string>;
}

export interface StoredObjectBody extends StoredObject {
  body: ReadableStream<Uint8Array>;
}

export interface PutOptions {
  contentType?: string;
  customMetadata?: Record<string, string>;
  /** Lowercase hex. The store rejects the write when the bytes do not match. */
  sha256?: string;
}

export type PutBody = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;

/**
 * A way to hand bytes to a reader without loading them in the Worker. A store
 * that can sign URLs returns `url`; one that cannot returns `stream`, and the
 * caller streams it through its own authorised route.
 */
export type ReadHandle =
  { kind: 'url'; url: string; expiresAt: Date } | { kind: 'stream'; object: StoredObjectBody };

export interface StorageAdapter {
  put(key: string, body: PutBody, options?: PutOptions): Promise<StoredObject>;
  get(key: string, range?: { offset: number; length?: number }): Promise<StoredObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(keys: string | string[]): Promise<void>;
  read(key: string, options?: { expiresInSeconds?: number }): Promise<ReadHandle | null>;
}
