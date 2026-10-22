/**
 * The recorder-to-server contract. `types.ts` is generated from `openapi.yaml`
 * with `pnpm --filter @mtxt/contract generate`; never edit it by hand.
 */
export type { paths, components, operations } from './types';

import type { components } from './types';

type Schemas = components['schemas'];

export type RecordingStatus = Schemas['RecordingStatus'];
export type RecordingSource = Schemas['RecordingSource'];
/**
 * Exactly one of `meeting_id` or `meeting`. openapi.yaml says so with oneOf and
 * `not: {}`; the generator renders `not: {}` as `unknown`, so this narrows the
 * excluded property to `never` and TypeScript rejects a body with both.
 */
export type CreateRecordingRequest =
  | (Schemas['RecordingDetails'] & { meeting_id: string; meeting?: never })
  | (Schemas['RecordingDetails'] & { meeting: Schemas['NewMeeting']; meeting_id?: never });
export type CreateRecordingResponse = Schemas['CreateRecordingResponse'];
export type ChunkReceipt = Schemas['ChunkReceipt'];
export type MissingChunks = Schemas['MissingChunks'];
export type Recording = Schemas['Recording'];
export type ApiError = Schemas['Error'];

/** Every chunk but the last is this size. Matches `chunk_size_bytes` in v0.1. */
export const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

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
