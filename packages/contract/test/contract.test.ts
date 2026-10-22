import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CHUNK_SIZE_BYTES,
  RECORDING_SOURCES,
  RECORDING_STATUSES,
  type CreateRecordingRequest,
} from '../src/index';

const specUrl = new URL('../openapi.yaml', import.meta.url);
const typesPath = fileURLToPath(new URL('../src/types.ts', import.meta.url));

describe('contract', () => {
  it('has generated types that match openapi.yaml', async () => {
    const generated = astToString(await openapiTS(specUrl));
    const checkedIn = await readFile(typesPath, 'utf8');
    // The CLI adds a header comment; compare the bodies.
    expect(checkedIn.endsWith(generated)).toBe(true);
  });

  it('declares the four recorder endpoints', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/recordings',
      '/recordings/{id}',
      '/recordings/{id}/chunks/{n}',
      '/recordings/{id}/complete',
    ]);
  });

  it('keeps the status and source enums in step with the constants', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    expect(spec.components.schemas.RecordingStatus.enum).toEqual([...RECORDING_STATUSES]);
    expect(spec.components.schemas.RecordingSource.enum).toEqual([...RECORDING_SOURCES]);
  });

  it('uses 8 MB chunks', () => {
    expect(CHUNK_SIZE_BYTES).toBe(8_388_608);
  });

  it('takes exactly one of meeting_id or meeting', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    const branches = spec.components.schemas.CreateRecordingRequest.oneOf;
    expect(branches).toHaveLength(2);
    const parts = branches.map(
      (b: { allOf: { required?: string[]; properties?: object }[] }) => b.allOf[1],
    );
    expect(parts[0].required).toEqual(['meeting_id']);
    expect(parts[0].properties.meeting).toEqual({ not: {} });
    expect(parts[1].required).toEqual(['meeting']);
    expect(parts[1].properties.meeting_id).toEqual({ not: {} });

    // Compile-time: `pnpm typecheck` fails if a body with both or neither is accepted.
    const details = {
      duration_s: 1,
      sha256: 'a'.repeat(64),
      size_bytes: 1,
      source: 'upload',
      content_type: 'audio/ogg',
    } as const;
    const existing: CreateRecordingRequest = { ...details, meeting_id: 'm1' };
    const created: CreateRecordingRequest = {
      ...details,
      meeting: { title: 'T', started_at: '2026-10-22T09:00:00Z' },
    };
    // @ts-expect-error both is not allowed
    const both: CreateRecordingRequest = { ...existing, meeting: created.meeting };
    // @ts-expect-error neither is not allowed
    const neither: CreateRecordingRequest = { ...details };
    expect([existing, created, both, neither]).toHaveLength(4);
  });
});
