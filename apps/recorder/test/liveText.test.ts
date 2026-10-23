import { describe, expect, it } from 'vitest';
import { accept, apply, atBottom, EMPTY, reconcile, statusKey } from '../src/liveText';
import type { LiveUpdate } from '../src/types';

const u = (over: Partial<LiveUpdate>): LiveUpdate => ({
  state: 'listening',
  reason: null,
  append: [],
  partial: null,
  reset: false,
  session: 1,
  seq: 1,
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

  it('keeps a line sent while the window fetched its state', () => {
    // Session 2 holds two lines (seq 4); line 3 (seq 5) arrives during startup.
    const state = {
      ...EMPTY,
      state: 'listening' as const,
      session: 2,
      seq: 4,
      lines: [line(10, 'En'), line(20, 'To')],
    };
    const buffered = [u({ session: 2, seq: 5, append: [line(30, 'Tre')] })];
    expect(reconcile(state, buffered).lines.map((l) => l.text)).toEqual(['En', 'To', 'Tre']);
    // If the state already had it, it is not added twice.
    const later = { ...state, seq: 5, lines: [...state.lines, line(30, 'Tre')] };
    expect(reconcile(later, buffered).lines).toHaveLength(3);
  });

  it('applies a Stop sent during startup and never brings old text back', () => {
    const state = {
      ...EMPTY,
      state: 'listening' as const,
      session: 2,
      seq: 7,
      lines: [line(10, 'En')],
    };
    const stopped = u({ state: 'stopped', reset: true, session: 2, seq: 8 });
    expect(reconcile(state, [stopped]).lines).toEqual([]);
    // State fetched after the stop, an older line still in the buffer.
    const after = apply(state, stopped);
    const old = u({ session: 2, seq: 6, append: [line(5, 'Gammel')] });
    expect(reconcile(after, [old, stopped]).lines).toEqual([]);
    // A line from the previous session after a new one began is ignored.
    const next = apply(after, u({ session: 3, seq: 1, reset: true }));
    expect(accept(next, u({ session: 2, seq: 9, append: [line(1, 'x')] })).lines).toEqual([]);
  });

  it('a new session whose first update was missed starts clean', () => {
    const t = { ...EMPTY, session: 1, seq: 9, lines: [line(1, 'Gammel')] };
    const r = accept(t, u({ session: 2, seq: 3, append: [line(2, 'Ny')] }));
    expect(r.lines.map((l) => l.text)).toEqual(['Ny']);
  });
});
