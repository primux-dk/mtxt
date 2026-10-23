import { AUDIT_ACTIONS, type AuditAction } from '@mtxt/adapters';

/** The audit page's state, all of it in the URL (behaviour.md rule 5): /settings/audit?action=shared&user=…&page=2. */
export const AUDIT_PAGE_SIZE = 50;

export interface AuditParams {
  action?: AuditAction;
  /** A user id. */
  user?: string;
  /** 1-based. */
  page: number;
}

type Raw = Record<string, string | string[] | undefined> | URLSearchParams;

export function parseAuditParams(raw: Raw): AuditParams {
  const get = (key: string) => {
    const value = raw instanceof URLSearchParams ? (raw.get(key) ?? undefined) : raw[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const action = AUDIT_ACTIONS.find((a) => a === get('action'));
  const user = get('user')?.trim().slice(0, 100) || undefined;
  const page = Number(get('page'));
  return {
    action,
    user,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, 100_000) : 1,
  };
}

export function auditHref(params: Partial<AuditParams>): string {
  const search = new URLSearchParams();
  if (params.action) search.set('action', params.action);
  if (params.user) search.set('user', params.user);
  if (params.page && params.page > 1) search.set('page', String(params.page));
  const query = search.toString();
  return query ? `/settings/audit?${query}` : '/settings/audit';
}

export const isAuditFiltered = (params: AuditParams) => Boolean(params.action || params.user);
