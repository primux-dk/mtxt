import { describe, expect, it } from 'vitest';
import { keepEmptyRange, parseRange } from '../lib/http-range';

describe('parseRange', () => {
  it('reads the forms the audio element sends', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ offset: 10, length: 10 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-30', 100)).toEqual({ offset: 70, length: 30 });
    expect(parseRange('bytes=-300', 100)).toEqual({ offset: 0, length: 100 });
  });

  it('serves the whole object only when there is no header', () => {
    expect(parseRange(null, 100)).toBeNull();
  });

  it('refuses malformed and multiple ranges', () => {
    for (const header of [
      'bytes=0-1,5-6',
      'items=0-1',
      'bytes=abc-def',
      'bytes=-',
      '',
      'bytes=1-2-3',
    ]) {
      expect(parseRange(header, 100), header).toBe('unsatisfiable');
    }
  });

  it('refuses ranges past the end', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('isMediaType', async () => {
  const { isMediaType } = await import('../lib/recordings/media-type');
  it('takes audio and video types only', () => {
    expect(isMediaType('audio/webm;codecs=opus')).toBe(true);
    expect(isMediaType('audio/mp4')).toBe(true);
    expect(isMediaType('video/webm')).toBe(true);
    expect(isMediaType('text/html')).toBe(false);
    expect(isMediaType('audio/webm\r\nx-evil: 1')).toBe(false);
    expect(isMediaType('application/octet-stream')).toBe(false);
  });
});

describe('keepEmptyRange', () => {
  it('turns an empty Range into one the route refuses, and leaves the rest alone', () => {
    const empty = keepEmptyRange(new Request('http://x/a', { headers: { range: '' } }));
    expect(parseRange(empty.headers.get('range'), 100)).toBe('unsatisfiable');
    const none = new Request('http://x/a');
    expect(keepEmptyRange(none)).toBe(none);
    const real = new Request('http://x/a', { headers: { range: 'bytes=0-1' } });
    expect(keepEmptyRange(real)).toBe(real);
  });
});
