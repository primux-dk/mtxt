import { describe, expect, it } from 'vitest';
import { defaultFileName, menuFor } from '../src/rowMenu';
import type { QueueItem } from '../src/types';

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: 'a',
  title: 'Plan for november',
  started_at: '2026-10-23T09:00:00Z',
  duration_s: 60,
  size_bytes: 1,
  status: 'pending',
  reason: null,
  done: 0,
  total: 1,
  server_status: null,
  meeting_url: null,
  active: false,
  blocked: null,
  local_error: null,
  can_save: true,
  has_file: true,
  recovered: false,
  needs_review: false,
  unsaved: null,
  gaps: 0,
  ...over,
});

const byId = (q: QueueItem) => Object.fromEntries(menuFor(q).map((m) => [m.id, m]));

describe('row menu', () => {
  it('a confirmed recording: save, open, delete without a question', () => {
    const m = byId(item({ status: 'confirmed', meeting_url: 'https://app.mtxt.co/meetings/m' }));
    expect(m.save?.enabled).toBe(true);
    expect(m.open?.enabled).toBe(true);
    expect(m.delete).toEqual({ id: 'delete', enabled: true, confirm: false });
  });

  it('an unconfirmed recording: delete asks by name, open is off', () => {
    for (const status of ['pending', 'warn', 'ask_user', 'failed_local', 'unreadable'] as const) {
      const m = byId(item({ status }));
      expect(m.delete?.confirm, status).toBe(true);
      expect(m.open?.enabled).toBe(false);
    }
  });

  it('never offers delete while it records or uploads', () => {
    expect(byId(item({ status: 'recording' })).delete).toBeUndefined();
    expect(byId(item({ status: 'uploading' })).delete).toBeUndefined();
    expect(byId(item({ status: 'pending', active: true })).delete).toBeUndefined();
  });

  it('without the audio: no save, no delete; open still works once uploaded', () => {
    const m = byId(
      item({ status: 'deleted', has_file: false, meeting_url: 'https://app.mtxt.co/meetings/m' }),
    );
    expect(m.save?.enabled).toBe(false);
    expect(m.delete).toBeUndefined();
    expect(m.open?.enabled).toBe(true);
  });

  it('names the file after the title and the date', () => {
    expect(
      defaultFileName({ title: 'Plan for november', started_at: '2026-10-23T09:00:00Z' }),
    ).toBe('Plan for november 2026-10-23.ogg');
  });
});
