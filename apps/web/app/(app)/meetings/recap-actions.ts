'use server';

import { and, eq } from 'drizzle-orm';
import { schema } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { HttpError } from '@/lib/http-error';
import { recapMeeting } from '@/lib/recap/access';
import { transcriptFor } from '@/lib/recap/job';
import {
  beginDraft,
  failDraft,
  listVersions,
  loadRecap,
  versionBody,
  writeVersion,
} from '@/lib/recap/store';
import { versionView, type VersionView } from '@/lib/recap/view';
import { SAVED_DELAY_S } from '@/lib/webhooks/rules';
import { queueMeetingEventQuietly } from '@/lib/webhooks/store';

/*
  The recap's actions besides the save (that is PUT /api/v1/meetings/{id}/recap):
  versions and their preview, Restore, Regenerate draft and Try again, the
  template, and the `@` search. Each checks the user itself: a server action
  is a public endpoint, whatever the page around it shows. Readers may list
  and preview versions; only the owner changes anything.
*/
export type RecapActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: 'forbidden' | 'not_found' | 'invalid' | 'no_transcript' | 'server' };

async function run<T extends object>(
  meetingId: string,
  need: 'read' | 'owner',
  body: (
    ctx: Awaited<ReturnType<typeof recapMeeting>> & { userId: string },
  ) => Promise<RecapActionResult<T>>,
): Promise<RecapActionResult<T>> {
  try {
    const user = await getSessionUser();
    if (!user) return { ok: false, code: 'forbidden' };
    const ctx = await recapMeeting(user, String(meetingId), need);
    return await body({ ...ctx, userId: user.id });
  } catch (error) {
    if (error instanceof HttpError) {
      return { ok: false, code: error.status === 404 ? 'not_found' : 'forbidden' };
    }
    console.error('Recap action failed:', (error as Error).name);
    return { ok: false, code: 'server' };
  }
}

/** Every version of the meeting's recap, newest first. */
export async function recapVersions(meetingId: string) {
  return run<{ versions: VersionView[] }>(meetingId, 'read', async ({ db, installId, meeting }) => {
    const recap = await loadRecap(db, installId, meeting.id);
    if (!recap) return { ok: true, versions: [] };
    return { ok: true, versions: (await listVersions(db, installId, recap.id)).map(versionView) };
  });
}

/** One version's markdown, for the preview. */
export async function recapVersionBody(meetingId: string, versionId: string) {
  return run<{ bodyMd: string }>(meetingId, 'read', async ({ db, installId, meeting }) => {
    const recap = await loadRecap(db, installId, meeting.id);
    const version = recap ? await versionBody(db, installId, recap.id, String(versionId)) : null;
    return version ? { ok: true, bodyMd: version.bodyMd } : { ok: false, code: 'not_found' };
  });
}

/**
 * A new version from an old one's body, by the owner, on top of whatever is
 * current. The editor takes the answer as its new base; another window gets
 * "Changed elsewhere" on its next save.
 */
export async function restoreRecapVersion(meetingId: string, versionId: string) {
  return run<{ version: VersionView; bodyMd: string }>(
    meetingId,
    'owner',
    async ({ db, installId, queue, meeting, userId }) => {
      const recap = await loadRecap(db, installId, meeting.id);
      const old = recap ? await versionBody(db, installId, recap.id, String(versionId)) : null;
      if (!recap || !old) return { ok: false, code: 'not_found' };
      // The current version can change under us; try on top of the newest a few times.
      for (let attempt = 0; attempt < 3; attempt++) {
        const now = attempt ? await loadRecap(db, installId, meeting.id) : recap;
        const result = await writeVersion(db, installId, {
          recapId: recap.id,
          meetingId: meeting.id,
          bodyMd: old.bodyMd,
          authorId: userId,
          note: `restored:${old.number}`,
          base: { versionId: now?.current?.id ?? null },
        });
        if (result.ok) {
          // A restore is a save: `recap.saved` a minute from now, joined by the saves after it.
          await queueMeetingEventQuietly(
            { db, installId, queue },
            {
              event: 'recap.saved',
              meetingId: meeting.id,
              dedupeKey: `saved:${result.version.id}`,
              delayS: SAVED_DELAY_S,
            },
          );
          const body = await versionBody(db, installId, recap.id, result.version.id);
          return {
            ok: true,
            version: versionView(result.version),
            bodyMd: body?.bodyMd ?? old.bodyMd,
          };
        }
        if (result.reason !== 'conflict') return { ok: false, code: 'not_found' };
      }
      return { ok: false, code: 'server' };
    },
  );
}

/**
 * Regenerate draft, and Try again after a failed draft: a new AI version from
 * the transcript and the meeting's template. It never replaces a human
 * version; it becomes the next one.
 */
export async function regenerateRecap(meetingId: string) {
  return run<object>(meetingId, 'owner', async ({ db, installId, queue, meeting }) => {
    const transcript = await transcriptFor(db, installId, meeting.id);
    if (!transcript || transcript.segments.length === 0)
      return { ok: false, code: 'no_transcript' };
    const started = await beginDraft(db, installId, meeting.id, meeting.templateId);
    if (!started) return { ok: false, code: 'server' };
    try {
      await queue.send({
        type: 'recap',
        meeting_id: meeting.id,
        transcript_id: transcript.id,
        install_id: installId,
        draft_token: started.token,
      });
    } catch (error) {
      await failDraft(db, installId, started.recapId, started.token, 'internal');
      throw error;
    }
    return { ok: true };
  });
}

/** The meeting's recap template; null for the install's default. Used by the next draft. */
export async function setRecapTemplate(meetingId: string, templateId: string | null) {
  return run<object>(meetingId, 'owner', async ({ db, installId, meeting }) => {
    if (templateId !== null) {
      const template = await db.query.templates.findFirst({
        where: and(
          eq(schema.templates.id, String(templateId)),
          eq(schema.templates.installId, installId),
        ),
      });
      if (!template) return { ok: false, code: 'invalid' };
    }
    await db
      .update(schema.meetings)
      .set({ templateId })
      .where(and(eq(schema.meetings.id, meeting.id), eq(schema.meetings.installId, installId)));
    return { ok: true };
  });
}

export interface MentionOption {
  /** `user:<id>` or `speaker:<id>`. */
  id: string;
  label: string;
  /** The colleague's address, or null for a speaker. */
  detail: string | null;
}

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/**
 * The `@` menu: colleagues by name or address, and the meeting's speakers
 * that are not linked to a colleague (a linked one is the colleague).
 * Folded in JavaScript, as the share dialog does.
 */
export async function searchMentions(meetingId: string, query: string) {
  return run<{ options: MentionOption[] }>(
    meetingId,
    'owner',
    async ({ db, installId, meeting }) => {
      const q = fold(String(query ?? '').trim()).slice(0, 100);
      const [users, speakers] = await Promise.all([
        db
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.installId, installId))
          .limit(5000),
        db
          .select({
            id: schema.speakers.id,
            label: schema.speakers.label,
            userId: schema.speakers.userId,
          })
          .from(schema.speakers)
          .where(
            and(
              eq(schema.speakers.installId, installId),
              eq(schema.speakers.meetingId, meeting.id),
            ),
          ),
      ]);
      const inMeeting = new Set(speakers.flatMap((s) => (s.userId ? [s.userId] : [])));
      const colleagues = users
        .filter((u) => !q || fold(u.name).includes(q) || fold(u.email).includes(q))
        // The meeting's own people first.
        .sort(
          (a, b) =>
            Number(inMeeting.has(b.id)) - Number(inMeeting.has(a.id)) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 8)
        .map((u): MentionOption => ({ id: `user:${u.id}`, label: u.name, detail: u.email }));
      const unlinked = speakers
        .filter((s) => !s.userId && (!q || fold(s.label).includes(q)))
        .slice(0, 4)
        .map((s): MentionOption => ({ id: `speaker:${s.id}`, label: s.label, detail: null }));
      return { ok: true, options: [...colleagues, ...unlinked] };
    },
  );
}
