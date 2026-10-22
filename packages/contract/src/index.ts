/**
 * The recorder-to-server contract. `types.ts` is generated from `openapi.yaml`
 * with `pnpm --filter @mtxt/contract generate`; never edit it by hand.
 */
export type { paths, components, operations } from './types';

import type { components } from './types';

type Schemas = components['schemas'];

export type RecordingStatus = Schemas['RecordingStatus'];
export type RecordingSource = Schemas['RecordingSource'];
export type CreateRecordingRequest = Schemas['CreateRecordingRequest'];
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
