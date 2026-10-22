export type Asset = { type: string; body: string } | { type: string; base64: string };

/**
 * Looks a path up by own key only. A plain object would answer `constructor`
 * or `__proto__` from its prototype; a Map does not.
 */
export function lookupAsset(
  assets: ReadonlyMap<string, Asset>,
  path: string,
): { type: string; body: string | Uint8Array<ArrayBuffer> } | null {
  const asset = assets.get(path);
  if (!asset) return null;
  if ('body' in asset) return asset;
  return { type: asset.type, body: Uint8Array.from(atob(asset.base64), (c) => c.charCodeAt(0)) };
}
