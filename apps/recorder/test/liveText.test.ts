import { describe, expect, it } from 'vitest';
import { apply, atBottom, EMPTY, statusKey } from '../src/liveText';
import type { LiveUpdate } from '../src/types';

const u = (over: Partial<LiveUpdate>): LiveUpdate => ({
  state: 'listening',
  reason: null,
  append: [],
  partial: null,
  reset: false,
  ...over,
});
const line = (at_s: number, text: string) => ({ at_s, text });

describe('live transcript', () => {
  it('appends finished lines and replaces the partial', () => {
    let t = apply(EMPTY, u({ reset: true, state: 'loading' }));
    t = apply(t, u({ append: [line(61, 'En')], partial: line(64, 'To') }));
    t = apply(t, u({ append: [line(64, 'To tre')] }));
    expect(t.lines.map((l) => l.text)).toEqual(['En', 'To tre']);
    expect(t.partial).toBeNull();
    expect(statusKey(t)).toBeNull();
  });

  it('drops everything on stop and on a reset', () => {
    const t = apply(EMPTY, u({ append: [line(1, 'x')] }));
    expect(apply(t, u({ state: 'stopped', reset: true })).lines).toEqual([]);
    expect(apply(t, u({ reset: true })).lines).toEqual([]);
  });

  it('says why the model could not run', () => {
    const t = apply(
      EMPTY,
      u({ state: 'error', reason: 'only one environment is allowed per process' }),
    );
    expect(statusKey(t)).toBe('live.errorReason');
    expect(statusKey(apply(EMPTY, u({ state: 'error' })))).toBe('live.error');
    expect(statusKey(apply(EMPTY, u({ state: 'paused' })))).toBe('live.paused');
  });

  it('knows when the view is at its end', () => {
    expect(atBottom({ scrollTop: 400, scrollHeight: 600, clientHeight: 200 })).toBe(true);
    expect(atBottom({ scrollTop: 100, scrollHeight: 600, clientHeight: 200 })).toBe(false);
  });
});
