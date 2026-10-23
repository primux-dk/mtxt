/*
  The recap rows: recaps, recap_versions and decisions. Every statement
  carries install_id.

  A version lands only on the base it names (behaviour.md rule 4): one D1
  batch inserts version n+1 where the recap's current version is still the
  base, and the recap, its body and its decisions follow only if that row
  went in. `(recap_id, number)` is unique, so two saves on one base cannot
  both land. An AI draft names no base; it lands while it holds the recap's
  `draft_token`, on top of whatever is current, so a regenerate never
  replaces a human version: it becomes the next one.

  Plain TypeScript with no Next.js imports: the queue consumer uses it too.
*/
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, syncSearch, type Db } from '@mtxt/adapters';
import { decisionRows, type DecisionRow } from './decisions';
import { parseMarkdown, plainText, toMarkdown } from './markdown';

const c = schema.recaps;
const v = schema.recapVersions;
const dc = schema.decisions;

/** A recap body as D1 can hold it, with room: 1,000,000 bytes is 150,000 words. */
export const MAX_BODY_BYTES = 1_000_000;

export interface VersionInfo {
  id: string;
  number: number;
  /** Null for an AI version. */
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  note: string | null;
}

export interface RecapState {
  id: string;
  meetingId: string;
  templateId: string | null;
  status: 'drafting' | 'ready' | 'failed';
  failureReason: string | null;
  /** When the current draft started, from its token; null when none is running. */
  draftingSince: Date | null;
  current: (VersionInfo & { bodyMd: string }) | null;
}

/** A draft token carries its start, so a draft that never finished can be offered again. */
export const newDraftToken = (now = Date.now()) => `${now}.${crypto.randomUUID()}`;
export const draftStarted = (token: string | null) => {
  const at = Number(token?.split('.')[0]);
  return Number.isFinite(at) && at > 0 ? new Date(at) : null;
};

async function versionInfo(db: Db, installId: string, versionId: string) {
  const [row] = await db
    .select({
      id: v.id,
      number: v.number,
      authorId: v.authorId,
      authorName: schema.users.name,
      createdAt: v.createdAt,
      note: v.note,
      bodyMd: v.bodyMd,
    })
    .from(v)
    .leftJoin(
      schema.users,
      and(eq(schema.users.id, v.authorId), eq(schema.users.installId, installId)),
    )
    .where(and(eq(v.id, versionId), eq(v.installId, installId)));
  return row ?? null;
}

/** The meeting's recap with its current version, or null when it has none. */
export async function loadRecap(
  db: Db,
  installId: string,
  meetingId: string,
): Promise<RecapState | null> {
  const recap = await db.query.recaps.findFirst({
    where: and(eq(c.installId, installId), eq(c.meetingId, meetingId)),
  });
  if (!recap) return null;
  const current = recap.currentVersionId
    ? await versionInfo(db, installId, recap.currentVersionId)
    : null;
  return {
    id: recap.id,
    meetingId: recap.meetingId,
    templateId: recap.templateId,
    status: recap.status,
    failureReason: recap.failureReason,
    draftingSince: recap.status === 'drafting' ? draftStarted(recap.draftToken) : null,
    current,
  };
}

/** Every version of a recap, newest first, with the author's current name. */
export async function listVersions(
  db: Db,
  installId: string,
  recapId: string,
): Promise<VersionInfo[]> {
  return db
    .select({
      id: v.id,
      number: v.number,
      authorId: v.authorId,
      authorName: schema.users.name,
      createdAt: v.createdAt,
      note: v.note,
    })
    .from(v)
    .leftJoin(
      schema.users,
      and(eq(schema.users.id, v.authorId), eq(schema.users.installId, installId)),
    )
    .where(and(eq(v.installId, installId), eq(v.recapId, recapId)))
    .orderBy(desc(v.number));
}

export async function versionBody(db: Db, installId: string, recapId: string, versionId: string) {
  const row = await db
    .select({ bodyMd: v.bodyMd, number: v.number })
    .from(v)
    .where(and(eq(v.id, versionId), eq(v.installId, installId), eq(v.recapId, recapId)))
    .get();
  return row ?? null;
}

/** The recap's decisions in order, with the owner's current name. */
export async function listDecisions(db: Db, installId: string, recapId: string) {
  return db
    .select({
      id: dc.id,
      position: dc.position,
      text: dc.text,
      done: dc.done,
      ownerUserId: dc.ownerUserId,
      ownerName: schema.users.name,
    })
    .from(dc)
    .leftJoin(
      schema.users,
      and(eq(schema.users.id, dc.ownerUserId), eq(schema.users.installId, installId)),
    )
    .where(and(eq(dc.installId, installId), eq(dc.recapId, recapId)))
    .orderBy(asc(dc.position));
}

/** The meeting's speakers by id, with the colleague each is linked to. */
export async function speakerUsers(db: Db, installId: string, meetingId: string) {
  const rows = await db
    .select({ id: schema.speakers.id, userId: schema.speakers.userId })
    .from(schema.speakers)
    .where(and(eq(schema.speakers.installId, installId), eq(schema.speakers.meetingId, meetingId)));
  return new Map(rows.map((r) => [r.id, r.userId]));
}

export type WriteResult =
  | { ok: true; version: VersionInfo }
  | { ok: false; reason: 'conflict'; current: VersionInfo | null }
  | { ok: false; reason: 'superseded' | 'not_found' };

export interface WriteInput {
  recapId: string;
  meetingId: string;
  bodyMd: string;
  /** The user who saved; null for the AI. */
  authorId: string | null;
  note?: string | null;
  /** A human save names the version it was made on; null for the first. */
  base?: { versionId: string | null };
  /** An AI draft names the token it holds instead. */
  draftToken?: string;
  now?: Date;
}

/**
 * Writes a version: the body (normalised through the schema), the recap row
 * and the decisions, in one batch, guarded by the base or the draft token.
 * Then the search index gets the recap's text.
 */
export async function writeVersion(
  db: Db,
  installId: string,
  input: WriteInput,
): Promise<WriteResult> {
  const doc = parseMarkdown(input.bodyMd);
  const bodyMd = toMarkdown(doc);
  if (new TextEncoder().encode(bodyMd).byteLength > MAX_BODY_BYTES) {
    throw new Error('The recap is too long to store.');
  }
  const rows: DecisionRow[] = decisionRows(doc, await speakerUsers(db, installId, input.meetingId));
  const id = crypto.randomUUID();
  const at = (input.now ?? new Date()).getTime();
  const guard =
    input.draftToken !== undefined
      ? sql`r.draft_token = ${input.draftToken}`
      : input.base?.versionId
        ? sql`r.current_version_id = ${input.base.versionId}`
        : sql`r.current_version_id is null`;
  const landed = sql`exists (select 1 from recap_versions x where x.id = ${id} and x.install_id = ${installId})`;
  const json = JSON.stringify(
    rows.map((r) => [crypto.randomUUID(), r.position, r.text, r.ownerUserId, r.done ? 1 : 0]),
  );

  const results = await db.batch([
    db.insert(v).select(
      sql`select ${id}, ${installId}, r.id,
          (select coalesce(max(y.number), 0) + 1 from recap_versions y where y.recap_id = r.id and y.install_id = ${installId}),
          ${input.authorId}, ${bodyMd}, ${input.note ?? null}, ${at}
        from recaps r where r.id = ${input.recapId} and r.install_id = ${installId} and ${guard}`,
    ),
    db
      .update(c)
      .set({
        currentVersionId: id,
        bodyMd,
        status: 'ready',
        failureReason: null,
        ...(input.draftToken !== undefined ? { draftToken: null } : {}),
      })
      .where(and(eq(c.id, input.recapId), eq(c.installId, installId), landed))
      .returning({ id: c.id }),
    db.delete(dc).where(and(eq(dc.installId, installId), eq(dc.recapId, input.recapId), landed)),
    db.insert(dc).select(
      sql`select json_extract(value, '$[0]'), ${installId}, ${input.recapId},
          json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
          json_extract(value, '$[4]')
        from json_each(${json}) where ${landed}`,
    ),
  ]);
  const written = (results[1] as unknown[]).length > 0;
  if (!written) {
    const recap = await db.query.recaps.findFirst({
      where: and(eq(c.id, input.recapId), eq(c.installId, installId)),
    });
    if (!recap) return { ok: false, reason: 'not_found' };
    if (input.draftToken !== undefined) return { ok: false, reason: 'superseded' };
    const current = recap.currentVersionId
      ? await versionInfo(db, installId, recap.currentVersionId)
      : null;
    return { ok: false, reason: 'conflict', current };
  }
  // The recap's text, without markdown syntax, for search (packet 6).
  await syncSearch(db, installId, {
    meetingId: input.meetingId,
    recap: { id: input.recapId, bodyMd: plainText(doc) },
  }).catch((error) => console.error('Could not index the recap', (error as Error).name));
  const version = await versionInfo(db, installId, id);
  return { ok: true, version: version! };
}

/**
 * Starts an AI draft for the meeting: the recap row (made if missing) goes
 * to `drafting` with a fresh token. With `onlyFirst`, nothing happens when
 * the recap already has a version or a draft running (the automatic draft
 * after a transcript never redrafts).
 */
export async function beginDraft(
  db: Db,
  installId: string,
  meetingId: string,
  templateId: string | null,
  options: { onlyFirst?: boolean; now?: number } = {},
): Promise<{ recapId: string; token: string } | null> {
  const token = newDraftToken(options.now);
  const [row] = await db
    .insert(c)
    .values({ installId, meetingId, templateId, status: 'drafting', draftToken: token })
    .onConflictDoUpdate({
      target: c.meetingId,
      set: { status: 'drafting', draftToken: token, failureReason: null, templateId },
      where: and(
        eq(c.installId, installId),
        ...(options.onlyFirst
          ? [sql`${c.currentVersionId} is null`, sql`${c.status} != 'drafting'`]
          : []),
      ),
    })
    .returning({ id: c.id, token: c.draftToken });
  return row && row.token === token ? { recapId: row.id, token } : null;
}

/** The draft failed: the recap says why, and keeps its current version. Only the draft that holds the token. */
export async function failDraft(
  db: Db,
  installId: string,
  recapId: string,
  token: string,
  reason: string,
) {
  await db
    .update(c)
    .set({ status: 'failed', failureReason: reason.slice(0, 64), draftToken: null })
    .where(and(eq(c.id, recapId), eq(c.installId, installId), eq(c.draftToken, token)));
}

/** Whether the token still holds the recap: a newer Regenerate takes it over. */
export async function holdsDraft(db: Db, installId: string, recapId: string, token: string) {
  const row = await db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.id, recapId), eq(c.installId, installId), eq(c.draftToken, token)))
    .get();
  return Boolean(row);
}
