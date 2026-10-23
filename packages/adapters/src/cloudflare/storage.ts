import type {
  PutBody,
  PutOptions,
  StorageAdapter,
  StoredObject,
  StoredObjectBody,
} from '../storage';

const describe = (o: R2Object): StoredObject => ({
  key: o.key,
  size: o.size,
  contentType: o.httpMetadata?.contentType,
  etag: o.etag,
  uploadedAt: o.uploaded,
  customMetadata: o.customMetadata,
});

/**
 * R2 behind the storage interface. R2 bindings cannot sign URLs (that needs S3
 * credentials), so `read` streams; the route that calls it does the auth check.
 */
export function r2Storage(bucket: R2Bucket): StorageAdapter {
  return {
    async put(key: string, body: PutBody, options: PutOptions = {}) {
      const object = await bucket.put(key, body, {
        httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
        customMetadata: options.customMetadata,
        sha256: options.sha256,
      });
      if (!object) throw new Error(`R2 refused the write to ${key}`);
      return describe(object);
    },
    async get(key, range) {
      const object = await bucket.get(key, range ? { range } : undefined);
      if (!object) return null;
      return { ...describe(object), body: object.body } satisfies StoredObjectBody;
    },
    async head(key) {
      const object = await bucket.head(key);
      return object ? describe(object) : null;
    },
    async delete(keys) {
      await bucket.delete(keys);
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
    async read(key) {
      const object = await this.get(key);
      return object ? { kind: 'stream', object } : null;
    },
    async createUpload(key, options = {}) {
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
        customMetadata: options.customMetadata,
      });
      return { uploadId: upload.uploadId };
    },
    async uploadPart(key, uploadId, partNumber, body) {
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
      return { partNumber: part.partNumber, etag: part.etag };
    },
    async completeUpload(key, uploadId, parts) {
      const object = await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
      return describe(object);
    },
    async abortUpload(key, uploadId) {
      await bucket.resumeMultipartUpload(key, uploadId).abort();
    },
  };
}
