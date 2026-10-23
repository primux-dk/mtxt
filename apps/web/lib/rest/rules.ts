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

/**
 * Where a page ends: the last row's place in the page's whole order. The
 * list is newest first (start, then id); search is best match first (the
 * kind of hit, the matched words, then start and id). A keyset, not an
 * offset, so a meeting added between two pages neither repeats a row nor
 * hides one.
 */
export type DatePosition = { startedAt: number; id: string };
export type RankPosition = DatePosition & { rank: number; hits: number };
export type Position = DatePosition | RankPosition;
export const isRankPosition = (p: Position): p is RankPosition => 'rank' in p;

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
  const body = {
    v: 1,
    f: fingerprint,
    ...('rank' in position ? { k: position.rank, h: position.hits } : {}),
    s: position.startedAt,
    i: position.id,
  };
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
  if (!Number.isSafeInteger(c.s) || typeof c.i !== 'string' || !c.i || c.i.length > 64) return null;
  const at = { startedAt: c.s as number, id: c.i };
  if (c.k === undefined && c.h === undefined) return at;
  const small = (n: unknown) =>
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000;
  return small(c.k) && small(c.h) ? { ...at, rank: c.k as number, hits: c.h as number } : null;
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

export const LIST_VIEWS = ['all', 'mine', 'shared', 'company', 'archived'] as const;
export const LIST_STATUSES = ['ready', 'transcribing', 'failed'] as const;
const LIST_PARAMS = ['view', 'q', 'status', 'since', 'cursor', 'limit'];

export interface ListParams {
  view: (typeof LIST_VIEWS)[number];
  q?: string;
  status?: (typeof LIST_STATUSES)[number];
  since?: Date;
  limit: number;
  cursor?: string;
  /** The filters a cursor is bound to. */
  fingerprint: string;
}

const ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

/**
 * An ISO 8601 date-time with a zone (RFC 3339, seconds optional), or a bare
 * date taken as UTC midnight; null for anything else. Every field is
 * checked against the calendar before the time is made, since Date would
 * roll 2026-02-31 over into March.
 */
export function parseIsoTime(raw: string): Date | null {
  const m = ISO_TIME.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', , sign, oh = '0', om = '0'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
  if (Number(oh) > 23 || Number(om) > 59) return null;
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om));
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return new Date(Date.UTC(year, month - 1, day, Number(h), Number(mi) - offset, Number(sec), ms));
}

/**
 * `GET /meetings`'s query, strictly: an unknown parameter or value is an
 * error naming it, not a silent default, so a client's typo shows at once.
 */
export function parseListParams(search: URLSearchParams): ListParams | { error: string } {
  for (const key of new Set(search.keys())) {
    if (!LIST_PARAMS.includes(key)) return { error: `Unknown parameter "${key}".` };
    if (search.getAll(key).length > 1) return { error: `"${key}" is given more than once.` };
  }
  const view = search.get('view') ?? 'all';
  if (!(LIST_VIEWS as readonly string[]).includes(view))
    return { error: `view is one of ${LIST_VIEWS.join(', ')}.` };
  const status = search.get('status') ?? undefined;
  if (status !== undefined && !(LIST_STATUSES as readonly string[]).includes(status))
    return { error: `status is one of ${LIST_STATUSES.join(', ')}.` };
  const q = search.get('q')?.trim() || undefined;
  if (q && q.length > 200) return { error: 'q is at most 200 characters.' };
  const rawSince = search.get('since');
  let since: Date | undefined;
  if (rawSince !== null) {
    since = parseIsoTime(rawSince) ?? undefined;
    if (!since) return { error: 'since is an ISO 8601 time, for example 2026-10-01T00:00:00Z.' };
  }
  const limit = parseLimit(search.get('limit'));
  if (limit === null) return { error: `limit is a whole number from 1 to ${MAX_LIMIT}.` };
  return {
    view: view as ListParams['view'],
    q,
    status: status as ListParams['status'],
    since,
    limit,
    cursor: search.get('cursor') ?? undefined,
    fingerprint: queryFingerprint({ view, q, status, since: since?.getTime() }),
  };
}

/** `GET /search`'s query: `q` (1 to 200 characters), `cursor`, `limit`. */
export function parseSearchParams(
  search: URLSearchParams,
): { q: string; limit: number; cursor?: string; fingerprint: string } | { error: string } {
  for (const key of new Set(search.keys())) {
    if (!['q', 'cursor', 'limit'].includes(key)) return { error: `Unknown parameter "${key}".` };
    if (search.getAll(key).length > 1) return { error: `"${key}" is given more than once.` };
  }
  const q = search.get('q')?.trim() ?? '';
  if (!q || q.length > 200) return { error: 'q is 1 to 200 characters.' };
  const limit = parseLimit(search.get('limit'));
  if (limit === null) return { error: `limit is a whole number from 1 to ${MAX_LIMIT}.` };
  return {
    q,
    limit,
    cursor: search.get('cursor') ?? undefined,
    fingerprint: queryFingerprint({ search: q }),
  };
}

/** One query parameter that must be one of `values`, `fallback` when absent; anything else is an error. */
export function parseFormat<T extends string>(
  search: URLSearchParams,
  values: readonly T[],
  fallback: T,
): T | { error: string } {
  for (const key of new Set(search.keys())) {
    if (key !== 'format') return { error: `Unknown parameter "${key}".` };
  }
  const format = search.get('format') ?? fallback;
  return (values as readonly string[]).includes(format)
    ? (format as T)
    : { error: `format is one of ${values.join(', ')}.` };
}

/** A query that takes no parameters: the first one given is an error. */
export function noParams(search: URLSearchParams): { error: string } | null {
  const [key] = search.keys();
  return key === undefined ? null : { error: `Unknown parameter "${key}".` };
}
