import { and, eq, inArray } from 'drizzle-orm';
import { audit, schema } from '@mtxt/adapters';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/http-error';
import { recapMeeting } from '@/lib/recap/access';
import { recapDocx } from '@/lib/recap/docx';
import { MENTION_ID } from '@/lib/recap/extensions';
import {
  attachment,
  EXPORT_FORMATS,
  EXPORT_TYPES,
  exportFileName,
  type ExportFormat,
} from '@/lib/recap/export';
import { IMAGE_FILE, imageKey } from '@/lib/recap/images';
import { parseMarkdown } from '@/lib/recap/markdown';
import { loadRecap } from '@/lib/recap/store';

/*
  The recap as a download: `?format=md` (the stored body) or `?format=docx`.
  Anyone who may read the meeting may export what they read. Each export is
  one `exported` audit row with the format. Library-only, not part of the
  recorder contract.
*/
type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  return api(async (user) => {
    const { id } = await params;
    const format = new URL(request.url).searchParams.get('format') ?? '';
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      throw new HttpError(400, 'invalid_request', 'Ask for format=md or format=docx.');
    }
    const { db, installId, storage, meeting } = await recapMeeting(user, id, 'read');
    const recap = await loadRecap(db, installId, meeting.id);
    if (!recap?.current) throw new HttpError(404, 'not_found', 'This meeting has no recap yet.');

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
          const [, meetingId, file] =
            /\/meetings\/([^/]+)\/recap\/images\/([^/]+)$/.exec(src) ?? [];
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
    await audit(db, installId, {
      userId: user.id,
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      action: 'exported',
      details: { format: format as ExportFormat },
    });
    return new Response(bytes, {
      headers: {
        'content-type': EXPORT_TYPES[format as ExportFormat],
        'content-disposition': attachment(
          exportFileName(meeting.title, meeting.startedAt, format as ExportFormat),
        ),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  });
}
