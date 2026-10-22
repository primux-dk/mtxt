import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CHUNK_SIZE_BYTES, RECORDING_SOURCES, RECORDING_STATUSES } from '../src/index';

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
});
