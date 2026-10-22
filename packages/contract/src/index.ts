/**
 * The recorder-to-server contract. `types.ts` is generated from `openapi.yaml`
 * with `pnpm --filter @mtxt/contract generate`; never edit it by hand.
 */
export type { paths, components, operations } from './types';

import type { components } from './types';

type Schemas = components['schemas'];
type Details = Omit<Schemas['RecordingDetails'], 'sha256' | 'size_bytes'> &
  (
    | { sha256: string; size_bytes: number }
    /** Still recording: both arrive with complete instead. */
    | { sha256?: never; size_bytes?: never }
  );

export type RecordingStatus = Schemas['RecordingStatus'];
export type RecordingSource = Schemas['RecordingSource'];
/**
 * Exactly one of `meeting_id` or `meeting`. openapi.yaml says so with oneOf and
 * `not: {}`; the generator renders `not: {}` as `unknown`, so this narrows the
 * excluded property to `never` and TypeScript rejects a body with both.
 * `sha256` and `size_bytes` come together or not at all, the same way.
 */
export type CreateRecordingRequest =
  | (Details & { meeting_id: string; meeting?: never })
  | (Details & { meeting: Schemas['NewMeeting']; meeting_id?: never });
export type CompleteRecordingRequest = Schemas['CompleteRecordingRequest'];
export type CreateRecordingResponse = Schemas['CreateRecordingResponse'];
export type ChunkReceipt = Schemas['ChunkReceipt'];
export type Conflict = Schemas['Conflict'];
export type Recording = Schemas['Recording'];
export type ApiError = Schemas['Error'];

/** Every chunk but the last is this size. Matches `chunk_size_bytes` in v0.1. */
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/** The largest file v0.1 accepts: 2 GB, 256 chunks. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/** The error codes v0.1 sends in `error.code` (openapi.yaml ErrorBody). */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'too_large',
  'source_disabled',
  'chunk_size',
  'not_uploading',
  'missing_chunks',
  'hash_mismatch',
  'size_mismatch',
  'session_expired',
  'busy',
  'unsupported_media_type',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const RECORDING_STATUSES = [
  'uploading',
  'confirmed',
  'transcribing',
  'transcribed',
  'failed',
] as const satisfies readonly RecordingStatus[];

export const RECORDING_SOURCES = [
  'desktop',
  'browser',
  'upload',
  'teams',
  'meet',
  'device',
] as const satisfies readonly RecordingSource[];
