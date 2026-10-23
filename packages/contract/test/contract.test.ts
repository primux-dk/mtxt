import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CHUNK_SIZE_BYTES,
  ERROR_CODES,
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

  it('declares the recorder endpoints', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/recorder/token',
      '/recorder/tokens/{id}',
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

  it('asks for a bearer token everywhere but the token poll', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    expect(spec.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.paths['/recorder/token'].post.security).toEqual([]);
    expect(Object.keys(spec.paths['/recorder/token'].post.responses).sort()).toEqual([
      '200',
      '202',
      '400',
      '410',
      '413',
      '429',
      '500',
    ]);
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

  it('takes sha256 and size_bytes together or not at all', () => {
    const recording = {
      duration_s: 0,
      source: 'browser',
      content_type: 'audio/webm',
      meeting_id: 'm1',
    } as const;
    const streaming: CreateRecordingRequest = recording;
    const whole: CreateRecordingRequest = { ...recording, sha256: 'a'.repeat(64), size_bytes: 1 };
    // @ts-expect-error a hash without a size is not allowed
    const half: CreateRecordingRequest = { ...recording, sha256: 'a'.repeat(64) };
    expect([streaming, whole, half]).toHaveLength(3);
  });

  it('lists every error code it documents', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    const documented = spec.components.schemas.ErrorBody.properties.code.description;
    for (const code of ERROR_CODES) expect(documented).toContain(`\`${code}\``);
  });
});

describe('contract details', () => {
  it('documents 500 on every operation and the chunk media type', async () => {
    const spec = parse(await readFile(specUrl, 'utf8'));
    for (const [path, item] of Object.entries<Record<string, { responses?: object }>>(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!op.responses) continue;
        expect(Object.keys(op.responses), `${method} ${path}`).toContain('500');
      }
    }
    const put = spec.paths['/recordings/{id}/chunks/{n}'].put;
    expect(Object.keys(put.requestBody.content)).toEqual(['application/octet-stream']);
    expect(Object.keys(put.responses)).toEqual(expect.arrayContaining(['409', '413', '415']));
    expect(Object.keys(spec.paths['/recordings/{id}/complete'].post.responses)).toContain('413');
    expect(put.parameters.find((p: { name: string }) => p.name === 'Content-Length').required).toBe(
      false,
    );
    for (const op of [put, spec.paths['/recordings/{id}/complete'].post]) {
      expect(op.responses['409'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Conflict',
      });
    }
  });

  it('encodes the paired hash and size and the media type', async () => {
    const details = parse(await readFile(specUrl, 'utf8')).components.schemas.RecordingDetails;
    expect(details.dependentRequired).toEqual({ sha256: ['size_bytes'], size_bytes: ['sha256'] });
    const pattern = new RegExp(details.properties.content_type.pattern);
    for (const ok of [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'video/webm',
      'audio/x-m4a',
      'Audio/WebM',
    ]) {
      expect(pattern.test(ok), ok).toBe(true);
    }
    for (const bad of ['text/html', 'application/octet-stream', 'audio/webm\r\nx: 1']) {
      expect(pattern.test(bad), bad).toBe(false);
    }
  });
});
