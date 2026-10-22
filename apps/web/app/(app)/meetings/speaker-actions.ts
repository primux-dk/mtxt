'use server';

import { and, eq } from 'drizzle-orm';
import { schema } from '@mtxt/adapters';
import { getSessionUser } from '@/lib/auth/session';
import { getAdapters } from '@/lib/install';
import { accessTo } from '@/lib/meetings/queries';

/*
  The owner's changes to a meeting's speakers (behaviour.md rules 2 and 4):
  rename, link to a colleague, unlink. Each sets the whole value, so a retry
  never doubles a change, and answers with the outcome; the screen rolls
  back on `ok: false`.
*/
export type SpeakerResult = { ok: true } | { ok: false; code: 'forbidden' | 'invalid' | 'server' };
export interface Colleague {
  id: string;
  name: string;
  email: string;
}

const MAX_SPEAKER_LABEL = 120;

async function owned(meetingId: string) {
  const user = await getSessionUser();
  if (!user) return null;
  const ctx = await getAdapters();
  const meeting = await ctx.db.query.meetings.findFirst({
    where: and(eq(schema.meetings.id, meetingId), eq(schema.meetings.installId, ctx.installId)),
  });
  const access = meeting ? await accessTo(ctx.db, ctx.installId, meeting, user) : null;
  return access === 'owner' ? ctx : null;
}

export async function updateSpeaker(
  meetingId: string,
  speakerId: string,
  change: { label: string; userId: string | null },
): Promise<SpeakerResult> {
  try {
    const ctx = await owned(meetingId);
    if (!ctx) return { ok: false, code: 'forbidden' };
    const label = String(change.label ?? '').trim();
    if (!label || label.length > MAX_SPEAKER_LABEL) return { ok: false, code: 'invalid' };
    const { db, installId } = ctx;
    if (change.userId !== null) {
      const colleague = await db.query.users.findFirst({
        where: and(
          eq(schema.users.id, String(change.userId)),
          eq(schema.users.installId, installId),
        ),
      });
      if (!colleague) return { ok: false, code: 'invalid' };
    }
    const updated = await db
      .update(schema.speakers)
      .set({ label, userId: change.userId })
      .where(
        and(
          eq(schema.speakers.id, speakerId),
          eq(schema.speakers.meetingId, meetingId),
          eq(schema.speakers.installId, installId),
        ),
      )
      .returning({ id: schema.speakers.id });
    return updated.length ? { ok: true } : { ok: false, code: 'invalid' };
  } catch (error) {
    console.error('Speaker change failed:', error);
    return { ok: false, code: 'server' };
  }
}

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/**
 * Colleagues whose name or address contains the text, for the owner of the
 * meeting. Folded in JavaScript, since SQLite lower-cases ASCII only and a
 * company directory is a few thousand rows at most.
 */
export async function searchColleagues(
  meetingId: string,
  query: string,
): Promise<Colleague[] | null> {
  const ctx = await owned(meetingId);
  if (!ctx) return null;
  const q = fold(String(query ?? '').trim()).slice(0, 100);
  if (!q) return [];
  const users = await ctx.db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.installId, ctx.installId))
    .limit(5000);
  return users
    .filter((u) => fold(u.name).includes(q) || fold(u.email).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 8);
}
