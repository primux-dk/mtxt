import { describe, expect, it } from 'vitest';
import { auditHref, isAuditFiltered, parseAuditParams } from '../lib/audit/params';

describe('the audit page URL', () => {
  it('reads action, user and page, and drops anything unknown', () => {
    expect(parseAuditParams(new URLSearchParams('action=shared&user=u1&page=3'))).toEqual({
      action: 'shared',
      user: 'u1',
      page: 3,
    });
    expect(parseAuditParams({ action: 'read_everything', page: '-1', user: ' ' })).toEqual({
      action: undefined,
      user: undefined,
      page: 1,
    });
  });

  it('round-trips, leaving defaults out', () => {
    const params = parseAuditParams({ action: 'visibility_changed', user: 'dev-user', page: '2' });
    expect(parseAuditParams(new URL(auditHref(params), 'http://x').searchParams)).toEqual(params);
    expect(auditHref({ page: 1 })).toBe('/settings/audit');
    expect(isAuditFiltered(parseAuditParams({ page: '4' }))).toBe(false);
    expect(isAuditFiltered(parseAuditParams({ user: 'x' }))).toBe(true);
  });
});
