import { describe, expect, it } from 'vitest';
import { type Asset, lookupAsset } from '../lib/asset-map';

const assets = new Map<string, Asset>([
  ['tokens.css', { type: 'text/css', body: ':root{}' }],
  ['font.woff2', { type: 'font/woff2', base64: btoa('wOF2') }],
]);

describe('lookupAsset', () => {
  it('returns text and binary assets', () => {
    expect(lookupAsset(assets, 'tokens.css')).toEqual({ type: 'text/css', body: ':root{}' });
    const font = lookupAsset(assets, 'font.woff2');
    expect(new TextDecoder().decode(font?.body as Uint8Array)).toBe('wOF2');
  });

  it('does not answer from the prototype', () => {
    expect(lookupAsset(assets, 'constructor')).toBeNull();
    expect(lookupAsset(assets, '__proto__')).toBeNull();
    expect(lookupAsset(assets, 'toString')).toBeNull();
  });

  it('returns null for unknown paths', () => {
    expect(lookupAsset(assets, 'nope')).toBeNull();
  });
});
