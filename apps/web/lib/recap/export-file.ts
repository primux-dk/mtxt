import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db, type Meeting, type StorageAdapter } from '@mtxt/adapters';
import { recapDocx } from './docx';
import { MENTION_ID } from './extensions';
import { attachment, EXPORT_TYPES, exportFileName, type ExportFormat } from './export';
import { IMAGE_FILE, imageKey } from './images';
import { parseMarkdown } from './markdown';
import { loadRecap } from './store';

/** A response header the REST handler takes as the ETag's input instead of the bytes, and removes. */
export const ETAG_BASIS = 'x-mtxt-etag-basis';

/**
 * The recap's current version as a download: the stored markdown, or Word
 * built from the same document with colleagues under their current names
 * and only this meeting's images. Null when the recap has no version. Used
 * by the export button's route and by the webhook's signed links.
 */
export async function recapFile(
  ctx: { db: Db; installId: string; storage: StorageAdapter },
  meeting: Pick<Meeting, 'id' | 'title' | 'startedAt'>,
  format: ExportFormat,
  options: { etagBasis?: boolean } = {},
): Promise<Response | null> {
  const { db, installId, storage } = ctx;
  const recap = await loadRecap(db, installId, meeting.id);
  if (!recap?.current) return null;

  let bytes: Uint8Array<ArrayBuffer> | string;
  /** What the file is made from, for the REST API's ETag: a Word file carries the time it was built. */
  let basis: unknown[] = [];
  if (format === 'md') bytes = recap.current.bodyMd;
  else {
    const doc = parseMarkdown(recap.current.bodyMd);
    // Mentions of colleagues under their current names.
    const ids = new Set<string>();
    doc.descendants((node) => {
      const match =
        node.type.name === 'mention' ? MENTION_ID.exec(String(node.attrs.id ?? '')) : null;
      if (match?.[1] === 'user') ids.add(match[2]!);
      return true;
    });
    const names = ids.size
      ? await db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(and(eq(schema.users.installId, installId), inArray(schema.users.id, [...ids])))
      : [];
    const byId = new Map(names.map((u) => [`user:${u.id}`, u.name]));
    basis = [recap.current.id, meeting.title, meeting.startedAt.getTime(), [...byId].sort()];
    bytes = await recapDocx({
      doc,
      title: meeting.title,
      subtitle: new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(
        meeting.startedAt,
      ),
      mentionName: (mention) => byId.get(mention),
      image: async (src) => {
        // Only this meeting's own images.
        const [, meetingId, file] = /\/meetings\/([^/]+)\/recap\/images\/([^/]+)$/.exec(src) ?? [];
        const kind = file ? IMAGE_FILE.exec(file)?.[1] : undefined;
        if (meetingId !== meeting.id || !file || !kind || kind === 'webp') return null;
        const object = await storage.get(imageKey(installId, meeting.id, file));
        if (!object) return null;
        return {
          bytes: new Uint8Array(await new Response(object.body).arrayBuffer()),
          type: kind as 'png' | 'jpg' | 'gif',
        };
      },
    });
  }
  const headers = new Headers({
    'content-type': EXPORT_TYPES[format],
    'content-disposition': attachment(exportFileName(meeting.title, meeting.startedAt, format)),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  if (options.etagBasis && basis.length) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(basis)),
    );
    headers.set(
      ETAG_BASIS,
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    );
  }
  return new Response(bytes, { headers });
}
