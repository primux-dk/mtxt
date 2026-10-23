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

/** One stored part of a multipart upload. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * Multipart uploads, for audio that arrives in chunks. R2 and S3 share the
 * model: every part but the last has the same size (at least 5 MiB), parts
 * may arrive in any order, and uploading a part number again replaces it.
 */
export interface MultipartStorage {
  createUpload(key: string, options?: Omit<PutOptions, 'sha256'>): Promise<{ uploadId: string }>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ArrayBuffer | Uint8Array,
  ): Promise<UploadedPart>;
  completeUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<StoredObject>;
  abortUpload(key: string, uploadId: string): Promise<void>;
}

export interface StorageAdapter extends MultipartStorage {
  put(key: string, body: PutBody, options?: PutOptions): Promise<StoredObject>;
  get(key: string, range?: { offset: number; length?: number }): Promise<StoredObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(keys: string | string[]): Promise<void>;
  /** Every key under `prefix` (a recap's images, for delete and retention). */
  list(prefix: string): Promise<string[]>;
  read(key: string, options?: { expiresInSeconds?: number }): Promise<ReadHandle | null>;
}
