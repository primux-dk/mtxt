/*
  The REST API's pure rules (docs/spec.md "API"): who may call, cursors and
  ETags. No Next.js and no database here, so the unit tests run them as is.
*/
import type { ApiTokenScope, TokenKind } from '@mtxt/adapters';

export type Verdict =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      code: 'unauthorized' | 'forbidden' | 'insufficient_scope';
      message: string;
    };

/**
 * Who may call a REST endpoint. A personal API token, `read_write` for a
 * write; the session cookie only where the library itself calls the route
 * (`session`, the recap editor's save). A recorder's token is refused: it is
 * for the recorder contract alone.
 */
export function authorise(
  token: { kind: TokenKind; scope: ApiTokenScope | null } | undefined,
  need: { write: boolean; session: boolean },
): Verdict {
  if (!token) {
    return need.session
      ? { ok: true }
      : {
          ok: false,
          status: 401,
          code: 'unauthorized',
          message: 'Send a personal API token as Authorization: Bearer <token>.',
        };
  }
  if (token.kind !== 'api') {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: "A recorder's token cannot use the REST API. Make an API token under API tokens.",
    };
  }
  if (need.write && token.scope !== 'read_write') {
    return {
      ok: false,
      status: 403,
      code: 'insufficient_scope',
      message: 'This token may only read. Make a token with the read_write scope to write.',
    };
  }
  return { ok: true };
}

/** Where a page of meetings ends: the last row's start and id (newest first), or an offset for search. */
export type Position = { startedAt: number; id: string } | { offset: number };

const bytesToBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const toBase64Url = (text: string) => bytesToBase64Url(new TextEncoder().encode(text));

const fromBase64Url = (text: string) => {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
};

/**
 * A short fingerprint of a query's filters (FNV-1a, 32 bits), carried in
 * its cursors, so a cursor from one query is refused by another rather
 * than paging it from a wrong place.
 */
export function queryFingerprint(filters: Record<string, string | number | undefined>): string {
  const text = JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((k) => [k, filters[k] ?? null]),
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** An opaque cursor: the position and the query's fingerprint, base64url JSON. */
export function encodeCursor(position: Position, fingerprint: string): string {
  const body =
    'offset' in position
      ? { v: 1, f: fingerprint, o: position.offset }
      : { v: 1, f: fingerprint, s: position.startedAt, i: position.id };
  return toBase64Url(JSON.stringify(body));
}

/** The position in a cursor made for the same query, else null. */
export function decodeCursor(raw: string, fingerprint: string): Position | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) return null;
  let body: unknown;
  try {
    body = JSON.parse(fromBase64Url(raw));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const c = body as Record<string, unknown>;
  if (c.v !== 1 || c.f !== fingerprint) return null;
  if (Number.isSafeInteger(c.o) && (c.o as number) >= 0 && (c.o as number) <= 100_000) {
    return { offset: c.o as number };
  }
  if (Number.isSafeInteger(c.s) && typeof c.i === 'string' && c.i.length > 0 && c.i.length <= 64) {
    return { startedAt: c.s as number, id: c.i };
  }
  return null;
}

/** Page sizes: 1 to 100, 50 by default. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}

/** A strong ETag over the bytes of a response: the first 16 bytes of their SHA-256, base64url. */
export async function etagFor(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `"${bytesToBase64Url(digest.subarray(0, 16))}"`;
}

/**
 * Whether `If-None-Match` names the ETag (RFC 9110 13.1.2: the weak
 * comparison, a list, or `*`).
 */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => bare(tag) === bare(etag));
}
