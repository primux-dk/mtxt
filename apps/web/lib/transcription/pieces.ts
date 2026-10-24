/*
  A long recording in pieces (docs/decisions.md, packet 18), for a
  synchronous provider with a size ceiling (Workers AI Whisper). The first
  delivery reads the file once and plans the pieces (lib/audio), stores the
  plan under the attempt's prefix and puts the prefix and the count on the
  transcript row. Then, piece by piece and in order: cut, transcribe, store
  the raw result as its own object, count it done on the row (which also
  extends the claim). A piece that fails throws like any provider error, so
  the queue's retry starts at that piece; the pieces already done stay. A
  delivery that has run for PIECE_BUDGET_MS lets its claim go and queues the
  rest as a new message, so no delivery comes near the consumer's
  15-minute limit. When the last piece is done the results are stitched
  (lib/stt/stitch) and written like any other result.
*/
import { and, eq } from 'drizzle-orm';
import { cleanupEntries, deleteStored, recordCleanup, schema } from '@mtxt/adapters';
import { buildPiece, planCut, UnsupportedAudio, type CutPlan, type OpenAudio } from '../audio';
import { stitch, type StitchPiece } from '../stt/stitch';
import { SttError, type PiecedTranscription, type SttResult } from '../stt/types';
import type { TranscribeDeps } from './job';
import { CLAIM_LEASE_MS, piecePrefix, release } from './store';

const t = schema.transcripts;

/** A delivery starts no new piece after this; the next message carries on. */
export const PIECE_BUDGET_MS = 8 * 60_000;

export const pieceKey = (prefix: string, index: number) =>
  `${prefix}piece-${String(index).padStart(3, '0')}.json`;
export const planKey = (prefix: string) => `${prefix}plan.json`;

/** What one piece's object holds: where it sits in the original, and what came back. */
export interface StoredPiece extends StitchPiece {
  index: number;
  endMs: number;
  bytes: number;
  /** The provider's own response for this piece. */
  raw: unknown;
}

export type PiecesOutcome =
  | { kind: 'done'; result: SttResult; rawPath: string }
  /** Queued again to carry on, or the claim was lost to another delivery. */
  | { kind: 'continued' }
  | { kind: 'lost' };

interface PiecesRun {
  deps: TranscribeDeps;
  recording: { id: string; storagePath: string; sizeBytes: number };
  claim: { transcriptId: string; token: string; provider: string };
  /** The claimed row as it was: a later delivery finds the plan on it. */
  row: { rawPath: string | null; chunksTotal: number | null; chunksDone: number | null };
  pieces: PiecedTranscription;
  language: string;
  keyterms: readonly string[];
  startedAt: number;
  /** The provider's name, for the error a file that cannot be cut gets. */
  call: string;
}

async function readJson<T>(deps: TranscribeDeps, key: string): Promise<T | null> {
  const object = await deps.storage.get(key);
  return object ? ((await new Response(object.body).json()) as T) : null;
}

const holds = (claim: PiecesRun['claim'], installId: string) =>
  and(
    eq(t.installId, installId),
    eq(t.id, claim.transcriptId),
    eq(t.claimToken, claim.token),
    eq(t.status, 'pending'),
  );

export async function runPieces(run: PiecesRun): Promise<PiecesOutcome> {
  const { deps, recording, claim } = run;
  const { db, installId, storage } = deps;
  const log = deps.log ?? console;
  const open: OpenAudio = async (range) => {
    const object = await storage.get(recording.storagePath, range);
    if (!object) throw new SttError('stt_failed', 'missing_audio');
    return object.body;
  };
  const unsplittable = (error: unknown) =>
    error instanceof UnsupportedAudio
      ? new SttError('stt_too_long', 'unsplittable', false, undefined, run.call)
      : error;

  let prefix = run.row.rawPath?.endsWith('/') ? run.row.rawPath : null;
  let plan = prefix && run.row.chunksTotal ? await readJson<CutPlan>(deps, planKey(prefix)) : null;
  let done = plan ? (run.row.chunksDone ?? 0) : 0;
  if (!plan) {
    // A prefix whose plan is gone: its pieces cannot be trusted, so they go and the plan is made again.
    const stale = prefix ? recordCleanup(db, installId, cleanupEntries([prefix])) : null;
    if (stale) await stale;
    const began = Date.now();
    plan = await planCut(open, recording.sizeBytes, run.pieces.limits).catch((error) => {
      throw unsplittable(error);
    });
    prefix = piecePrefix(installId, recording.id, claim.provider, claim.token);
    await storage.put(planKey(prefix), JSON.stringify(plan), { contentType: 'application/json' });
    const planned = await db
      .update(t)
      .set({ rawPath: prefix, chunksTotal: plan.pieces.length, chunksDone: 0 })
      .where(holds(claim, installId))
      .returning({ id: t.id });
    if (!planned.length) {
      await storage.delete(planKey(prefix)).catch(() => {});
      return { kind: 'lost' };
    }
    log.log(
      `Planned ${plan.pieces.length} pieces of ${plan.format} for`,
      recording.id,
      `(${Math.round(plan.durationMs / 1000)} s of audio, ${Date.now() - began} ms)`,
    );
    done = 0;
  }

  const cache = new Map<string, unknown>();
  for (let k = done; k < plan.pieces.length; k++) {
    if (k > done && Date.now() - run.startedAt > PIECE_BUDGET_MS) {
      await release(db, installId, claim.transcriptId, claim.token);
      await deps.queue.send({
        type: 'transcribe',
        recording_id: recording.id,
        install_id: installId,
      });
      log.log(`Piece ${k + 1} of ${plan.pieces.length} goes to the next delivery`, recording.id);
      return { kind: 'continued' };
    }
    const piece = plan.pieces[k]!;
    const began = Date.now();
    const audio = await buildPiece(plan, k, open, cache).catch((error) => {
      throw unsplittable(error);
    });
    const built = Date.now() - began;
    const result = await run.pieces.transcribePiece({
      audio,
      contentType: plan.contentType,
      language: run.language,
      keyterms: run.keyterms,
    });
    const stored: StoredPiece = {
      index: k,
      startMs: piece.startMs,
      endMs: piece.endMs,
      seamStartMs: piece.seamStartMs,
      seamEndMs: piece.seamEndMs,
      bytes: audio.byteLength,
      result: {
        language: result.language,
        model: result.model,
        segments: result.segments,
        speakers: result.speakers,
        ...(result.words ? { words: result.words } : {}),
      },
      raw: result.raw,
    };
    await storage.put(pieceKey(prefix!, k), JSON.stringify(stored), {
      contentType: 'application/json',
    });
    const counted = await db
      .update(t)
      .set({ chunksDone: k + 1, claimExpiresAt: new Date(Date.now() + CLAIM_LEASE_MS) })
      .where(holds(claim, installId))
      .returning({ id: t.id });
    log.log(
      `Piece ${k + 1} of ${plan.pieces.length}:`,
      recording.id,
      `${audio.byteLength} bytes, ${Math.round((piece.endMs - piece.startMs) / 1000)} s of audio,`,
      `cut in ${built} ms, transcribed in ${Date.now() - began - built} ms`,
    );
    if (!counted.length) {
      // The row was deleted or reset meanwhile (a delete, retention, Try again): its prefix was
      // cleaned up before this piece landed, so the piece, and the prefix with it, go now.
      // A row that still holds the prefix belongs to the delivery that took the claim over.
      const still = await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(eq(t.installId, installId), eq(t.id, claim.transcriptId), eq(t.rawPath, prefix!)),
        )
        .get();
      if (!still) await deleteStored(storage, prefix!).catch(() => {});
      return { kind: 'lost' };
    }
  }

  const pieces: StoredPiece[] = [];
  for (let k = 0; k < plan.pieces.length; k++) {
    const piece = await readJson<StoredPiece>(deps, pieceKey(prefix!, k));
    // A piece counted done whose object is gone: the attempt cannot be finished.
    if (!piece) throw new SttError('stt_failed', 'internal', false, undefined, `piece ${k + 1}`);
    pieces.push(piece);
  }
  return { kind: 'done', result: stitch(pieces, Math.round(plan.durationMs)), rawPath: prefix! };
}
