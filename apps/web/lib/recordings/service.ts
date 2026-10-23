import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import {
  CHUNK_SIZE_BYTES,
  MAX_RECORDING_BYTES,
  RECORDING_SOURCES,
  type CompleteRecordingRequest,
  type CreateRecordingRequest,
  type CreateRecordingResponse,
  type Recording as ApiRecording,
} from '@mtxt/contract';
import {
  foldTitle,
  schema,
  type Db,
  type QueueAdapter,
  type Recording,
  type Settings,
  type StorageAdapter,
  type UploadSessions,
  syncSearch,
} from '@mtxt/adapters';
import type { SessionUser as CurrentUser } from '../auth/session';
import { HttpError } from '../http-error';
import { accessTo } from '../meetings/queries';
import { isMediaType } from './media-type';

export interface RecordingContext {
  db: Db;
  installId: string;
  storage: StorageAdapter;
  queue: QueueAdapter;
  uploads: UploadSessions;
  settings: Pick<Settings, 'defaultVisibility' | 'recordingSources'>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const r = schema.recordings;
const m = schema.meetings;

/** File extension for the storage path, from the audio's MIME type. */
export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  const known: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'video/webm': 'webm',
    'video/mp4': 'mp4',
  };
  return known[type] ?? 'audio';
}

/** recordings/{install_id}/{meeting_id}/{recording_id}.{ext} (packet 3 decision). */
export const storagePath = (
  installId: string,
  meetingId: string,
  recordingId: string,
  ext: string,
) => `recordings/${installId}/${meetingId}/${recordingId}.${ext}`;

function invalid(message: string): never {
  throw new HttpError(400, 'invalid_request', message);
}

/** Checks a create request by hand: the contract's shape, the limits and the install's sources. */
export function validateCreate(
  body: unknown,
  allowedSources: readonly string[],
): CreateRecordingRequest {
  if (typeof body !== 'object' || body === null) invalid('Send a JSON object.');
  const b = body as Record<string, unknown>;
  const hasId = b.meeting_id !== undefined;
  const hasMeeting = b.meeting !== undefined;
  if (hasId === hasMeeting) invalid('Send exactly one of meeting_id or meeting.');
  if (hasId && (typeof b.meeting_id !== 'string' || !b.meeting_id))
    invalid('meeting_id is a string.');
  if (hasMeeting) {
    const meeting = b.meeting as Record<string, unknown> | null;
    if (typeof meeting !== 'object' || meeting === null) invalid('meeting is an object.');
    const title = typeof meeting.title === 'string' ? meeting.title.trim() : '';
    if (!title || title.length > 500) invalid('meeting.title is 1 to 500 characters.');
    if (typeof meeting.started_at !== 'string' || Number.isNaN(Date.parse(meeting.started_at))) {
      invalid('meeting.started_at is a date-time.');
    }
  }
  if (!Number.isInteger(b.duration_s) || (b.duration_s as number) < 0) {
    invalid('duration_s is a whole number of seconds.');
  }
  if (
    typeof b.source !== 'string' ||
    !(RECORDING_SOURCES as readonly string[]).includes(b.source)
  ) {
    invalid('source is not a recording source.');
  }
  if (!allowedSources.includes(b.source)) {
    throw new HttpError(
      403,
      'source_disabled',
      `This install does not accept ${b.source} recordings.`,
    );
  }
  if (typeof b.content_type !== 'string' || !isMediaType(b.content_type)) {
    invalid('content_type is an audio or video MIME type, for example audio/webm.');
  }

  const hasSha = b.sha256 !== undefined;
  if (hasSha !== (b.size_bytes !== undefined)) invalid('Send sha256 and size_bytes together.');
  if (hasSha) {
    if (typeof b.sha256 !== 'string' || !SHA256.test(b.sha256)) invalid('sha256 is lowercase hex.');
    if (!Number.isInteger(b.size_bytes) || (b.size_bytes as number) < 1) {
      invalid('size_bytes is a whole number above 0.');
    }
    if ((b.size_bytes as number) > MAX_RECORDING_BYTES) {
      throw new HttpError(413, 'too_large', 'The file is larger than 2 GB.');
    }
  }
  return b as unknown as CreateRecordingRequest;
}

export function validateComplete(body: unknown): CompleteRecordingRequest | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object') invalid('Send a JSON object or no body.');
  const b = body as Record<string, unknown>;
  if (typeof b.sha256 !== 'string' || !SHA256.test(b.sha256)) invalid('sha256 is lowercase hex.');
  if (!Number.isInteger(b.size_bytes) || (b.size_bytes as number) < 1) {
    invalid('size_bytes is a whole number above 0.');
  }
  if ((b.size_bytes as number) > MAX_RECORDING_BYTES) {
    throw new HttpError(413, 'too_large', 'The file is larger than 2 GB.');
  }
  if (
    b.duration_s !== undefined &&
    (!Number.isInteger(b.duration_s) || (b.duration_s as number) < 0)
  ) {
    invalid('duration_s is a whole number of seconds.');
  }
  return b as unknown as CompleteRecordingRequest;
}

export function toApi(
  rec: Recording,
  session?: { chunksReceived: number[]; chunkCount: number | null },
): ApiRecording {
  const chunkCount = rec.sizeBytes ? Math.ceil(rec.sizeBytes / CHUNK_SIZE_BYTES) : null;
  return {
    id: rec.id,
    meeting_id: rec.meetingId,
    status: rec.status,
    sha256: rec.sha256 || null,
    size_bytes: rec.sizeBytes || null,
    duration_s: rec.durationS,
    source: rec.source,
    created_at: rec.createdAt.toISOString(),
    confirmed_at: rec.confirmedAt?.toISOString() ?? null,
    chunk_count: session?.chunkCount ?? chunkCount,
    chunks_received: rec.status === 'uploading' ? (session?.chunksReceived ?? []) : [],
    error: rec.failure ? { code: rec.failure, message: failureMessage(rec.failure) } : null,
  };
}

function failureMessage(code: string): string {
  switch (code) {
    case 'hash_mismatch':
      return 'The SHA-256 of the file did not match. Upload it again.';
    case 'size_mismatch':
      return 'The file size did not match. Upload it again.';
    case 'session_expired':
      return 'The upload was not completed within 7 days. Upload it again.';
    default:
      return 'Transcription failed.';
  }
}

/** A recording with its meeting, for a caller who must own the meeting. */
async function ownedRecording(ctx: RecordingContext, user: CurrentUser, id: string) {
  const row = await ctx.db
    .select({ recording: r, ownerId: m.ownerId, visibility: m.visibility, deletedAt: m.deletedAt })
    .from(r)
    .innerJoin(m, and(eq(m.id, r.meetingId), eq(m.installId, ctx.installId)))
    .where(and(eq(r.id, id), eq(r.installId, ctx.installId)))
    .get();
  if (!row || row.deletedAt) throw new HttpError(404, 'not_found', 'No such recording.');
  if (row.ownerId !== user.id) {
    throw new HttpError(403, 'forbidden', 'Only the meeting owner uploads to it.');
  }
  return row.recording;
}

export async function createRecording(
  ctx: RecordingContext,
  user: CurrentUser,
  body: unknown,
): Promise<CreateRecordingResponse> {
  const req = validateCreate(body, ctx.settings.recordingSources);
  let meetingId: string;
  if (req.meeting_id !== undefined) {
    const meeting = await ctx.db.query.meetings.findFirst({
      where: and(eq(m.id, req.meeting_id), eq(m.installId, ctx.installId)),
    });
    // Not readable looks the same as absent; readable but not owned is a 403.
    const access = meeting ? await accessTo(ctx.db, ctx.installId, meeting, user) : null;
    if (!meeting || !access) throw new HttpError(404, 'not_found', 'No such meeting.');
    if (access !== 'owner')
      throw new HttpError(403, 'forbidden', 'Only the meeting owner uploads to it.');
    meetingId = meeting.id;
  } else {
    const title = req.meeting.title.trim();
    const [created] = await ctx.db
      .insert(m)
      .values({
        installId: ctx.installId,
        ownerId: user.id,
        title,
        titleFolded: foldTitle(title),
        startedAt: new Date(req.meeting.started_at),
        visibility: ctx.settings.defaultVisibility,
      })
      .returning({ id: m.id });
    meetingId = created!.id;
    await syncSearch(ctx.db, ctx.installId, { meetingId, title });
  }

  const id = crypto.randomUUID();
  const key = storagePath(ctx.installId, meetingId, id, extensionFor(req.content_type));
  await ctx.db.insert(r).values({
    id,
    installId: ctx.installId,
    meetingId,
    uploadedBy: user.id,
    source: req.source,
    durationS: req.duration_s,
    // '' and 0 until complete when the recording is still being made (schema.ts).
    sha256: req.sha256 ?? '',
    sizeBytes: req.size_bytes ?? 0,
    contentType: req.content_type,
    storagePath: key,
    status: 'uploading',
  });
  await ctx.uploads.get(id).begin({
    recordingId: id,
    installId: ctx.installId,
    meetingId,
    key,
    contentType: req.content_type,
    sizeBytes: req.size_bytes ?? null,
    sha256: req.sha256 ?? null,
  });
  return {
    id,
    meeting_id: meetingId,
    upload_url: `/api/v1/recordings/${id}/chunks`,
    chunk_size_bytes: CHUNK_SIZE_BYTES,
    chunk_count: req.size_bytes ? Math.ceil(req.size_bytes / CHUNK_SIZE_BYTES) : null,
    status: 'uploading',
  };
}

export async function uploadChunk(
  ctx: RecordingContext,
  user: CurrentUser,
  id: string,
  n: number,
  request: Request,
) {
  if (!Number.isInteger(n) || n < 1) invalid('The chunk number is a whole number from 1.');
  // Who, which recording and its state first: no byte is read for a refused chunk.
  const rec = await ownedRecording(ctx, user, id);
  if (rec.status !== 'uploading') {
    throw new HttpError(409, 'not_uploading', `The recording is ${rec.status}.`);
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/octet-stream') {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Send the chunk as application/octet-stream.',
    );
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > CHUNK_SIZE_BYTES) {
    throw new HttpError(413, 'too_large', `A chunk is at most ${CHUNK_SIZE_BYTES} bytes.`);
  }
  // The session reads the body, at most one chunk, and only once it accepts it.
  const result = await ctx.uploads.get(id).putChunk(n, request.body);
  if (!result.ok) {
    const status = { chunk_size: 400, too_large: 413, not_uploading: 409, busy: 409 }[result.code];
    throw new HttpError(
      status,
      result.code,
      result.message,
      {},
      result.code === 'busy' ? { 'retry-after': '1' } : {},
    );
  }
  return {
    n: result.n,
    size_bytes: result.sizeBytes,
    chunks_received: result.chunksReceived,
    chunk_count: result.chunkCount,
  };
}

/**
 * Verifies the whole file. On a match the recording is confirmed, a
 * transcribe job is queued and the status moves to transcribing. The
 * response is the recording at confirmation. Calling it again is safe at any
 * point: it finishes whatever the last call left undone.
 */
export async function completeRecording(
  ctx: RecordingContext,
  user: CurrentUser,
  id: string,
  body: unknown,
): Promise<ApiRecording> {
  const final = validateComplete(body);
  let rec = await ownedRecording(ctx, user, id);
  if (rec.status === 'failed') {
    const code = (rec.failure ?? 'hash_mismatch') as 'hash_mismatch';
    if (rec.confirmedAt) return toApi(rec);
    throw new HttpError(422, code, failureMessage(code));
  }

  if (rec.status === 'uploading') {
    const result = await ctx.uploads
      .get(id)
      .complete(final ? { sha256: final.sha256, sizeBytes: final.size_bytes } : undefined);
    if (!result.ok) {
      if (result.code === 'missing_chunks') {
        throw new HttpError(409, 'missing_chunks', result.message, { missing: result.missing });
      }
      if (result.code === 'invalid_request') invalid(result.message);
      if (result.code === 'not_uploading') {
        throw new HttpError(409, 'not_uploading', result.message);
      }
      await ctx.db
        .update(r)
        .set({ status: 'failed', failure: result.code })
        .where(and(eq(r.id, id), eq(r.installId, ctx.installId), eq(r.status, 'uploading')));
      throw new HttpError(422, result.code, result.message);
    }
    const [confirmed] = await ctx.db
      .update(r)
      .set({
        status: 'confirmed',
        confirmedAt: new Date(),
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
        ...(final?.duration_s !== undefined ? { durationS: final.duration_s } : {}),
      })
      .where(and(eq(r.id, id), eq(r.installId, ctx.installId), eq(r.status, 'uploading')))
      .returning();
    rec = confirmed ?? (await ownedRecording(ctx, user, id));
  }

  const atConfirmation = toApi(rec);
  if (rec.status === 'confirmed') {
    // The first confirmed recording becomes primary when the meeting has none.
    await ctx.db.run(
      sql`update recordings set is_primary = 1 where id = ${id} and install_id = ${ctx.installId}
        and not exists (select 1 from recordings p
          where p.install_id = ${ctx.installId} and p.meeting_id = ${rec.meetingId} and p.is_primary = 1)`,
    );
    await ctx.queue.send({ type: 'transcribe', recording_id: id, install_id: ctx.installId });
    await ctx.db
      .update(r)
      .set({ status: 'transcribing' })
      .where(and(eq(r.id, id), eq(r.installId, ctx.installId), eq(r.status, 'confirmed')));
  }
  return atConfirmation;
}

/** The recording, for anyone who may read its meeting. */
export async function getRecording(
  ctx: RecordingContext,
  user: CurrentUser,
  id: string,
): Promise<ApiRecording> {
  const row = await ctx.db
    .select({ recording: r, meeting: m })
    .from(r)
    .innerJoin(m, and(eq(m.id, r.meetingId), eq(m.installId, ctx.installId)))
    .where(and(eq(r.id, id), eq(r.installId, ctx.installId)))
    .get();
  if (!row) throw new HttpError(404, 'not_found', 'No such recording.');
  if (!(await accessTo(ctx.db, ctx.installId, row.meeting, user))) {
    throw new HttpError(404, 'not_found', 'No such recording.');
  }
  const session =
    row.recording.status === 'uploading' ? await ctx.uploads.get(id).status() : undefined;
  return toApi(row.recording, session);
}
