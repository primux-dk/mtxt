import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db, type Meeting, type StorageAdapter } from '@mtxt/adapters';
import { recapDocx } from './docx';
import { MENTION_ID } from './extensions';
import { attachment, EXPORT_TYPES, exportFileName, type ExportFormat } from './export';
import { IMAGE_FILE, imageKey } from './images';
import { parseMarkdown } from './markdown';
import { loadRecap } from './store';

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
): Promise<Response | null> {
  const { db, installId, storage } = ctx;
  const recap = await loadRecap(db, installId, meeting.id);
  if (!recap?.current) return null;

  let bytes: Uint8Array<ArrayBuffer> | string;
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
  return new Response(bytes, {
    headers: {
      'content-type': EXPORT_TYPES[format],
      'content-disposition': attachment(exportFileName(meeting.title, meeting.startedAt, format)),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
