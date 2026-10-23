import { describe, expect, it } from 'vitest';
import { EMPTY, view } from '../src/liveText';

describe('live text', () => {
  it('shows the last finished line and the line in progress', () => {
    const v = view({ state: 'listening', lines: ['En', 'To'], partial: 'Tre' });
    expect(v).toEqual({ prev: 'To', current: 'Tre', status: null, paused: false });
  });

  it('drops everything when the session stops', () => {
    expect(view({ state: 'stopped', lines: [], partial: '' })).toEqual(EMPTY);
    expect(view(null)).toEqual(EMPTY);
  });

  it('turns states into status lines', () => {
    expect(view({ state: 'paused', lines: ['x'], partial: '' })).toMatchObject({
      status: 'live.paused',
      paused: true,
      current: '',
    });
    expect(view({ state: 'listening', lines: [], partial: '' }).status).toBe('live.listening');
  });
});
