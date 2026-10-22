import { describe, expect, it } from 'vitest';
import { parseRange } from '../lib/http-range';

describe('parseRange', () => {
  it('reads the forms the audio element sends', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ offset: 10, length: 10 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange('bytes=-30', 100)).toEqual({ offset: 70, length: 30 });
    expect(parseRange('bytes=-300', 100)).toEqual({ offset: 0, length: 100 });
  });

  it('serves the whole object when there is no single range', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
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
