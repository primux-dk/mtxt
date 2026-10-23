import { describe, expect, it } from 'vitest';
import { retentionBatch, retentionDeadlines, retentionNotice } from '../src/db/retention';
import { syncSearch } from '../src/db/search';
import { DAY, fixtures, INSTALL, rows, testDb } from './sqlite';

const NOW = new Date(Date.UTC(2026, 9, 22, 3));
const SETTINGS = { retentionAudioDays: 30, retentionTranscriptDays: 365 };
const ago = (days: number) => NOW.getTime() - days * DAY;

function setup() {
  const { db, sqlite } = testDb();
  const f = fixtures(sqlite);
  f.user('owner');
  const deleted: string[] = [];
  const storage = {
    list: async () => [] as string[],
    delete: async (keys: string | string[]) => void deleted.push(...[keys].flat()),
  };
  const run = (limit?: number) =>
    retentionBatch({ db, storage, installId: INSTALL }, SETTINGS, NOW, limit);
  /** A meeting with a recording, a transcript of two segments and a recap with a docx. */
  const full = async (id: string, startedDaysAgo: number, keep = false) => {
    f.meeting(id, { owner: 'owner', startedAt: ago(startedDaysAgo), keep });
    f.recording(`${id}-r`, id);
    const segments = f.transcript(`${id}-t`, `${id}-r`, ['første', 'anden']);
    const recap = f.recap(`${id}-c`, id, '# Referat', `exports/${id}.docx`);
    await syncSearch(db, INSTALL, { meetingId: id, title: id, segments, recap });
  };
  const count = (table: string, meetingId: string) =>
    rows<{ n: number }>(
      sqlite,
      table === 'segments'
        ? `select count(*) as n from segments where transcript_id = '${meetingId}-t'`
        : table === 'transcripts'
          ? `select count(*) as n from transcripts where recording_id = '${meetingId}-r'`
          : table === 'recap_versions' || table === 'decisions'
            ? `select count(*) as n from ${table} where recap_id = '${meetingId}-c'`
            : table === 'meeting_search'
              ? `select count(*) as n from meeting_search where meeting_id = '${meetingId}' and kind != 'title'`
              : `select count(*) as n from ${table} where meeting_id = '${meetingId}'`,
    )[0]!.n;
  const meeting = (id: string) =>
    rows<{ deleted_at: number | null }>(
      sqlite,
      `select deleted_at from meetings where id = '${id}'`,
    )[0];
  const recording = (id: string) =>
    rows<{ storage_path: string; delete_audio_at: number | null }>(
      sqlite,
      `select storage_path, delete_audio_at from recordings where id = '${id}-r'`,
    )[0]!;
  return { db, sqlite, f, run, full, deleted, count, meeting, recording };
}

describe('retention deadlines and the notice', () => {
  const started = new Date(Date.UTC(2026, 8, 1, 9));
  const meeting = { startedAt: started, keep: false, deletedAt: null };

  it('counts both deadlines from started_at', () => {
    expect(retentionDeadlines(started, SETTINGS)).toEqual({
      audio: new Date(started.getTime() + 30 * DAY),
      text: new Date(started.getTime() + 365 * DAY),
    });
  });

  it('announces a deadline 7 days ahead, not 8', () => {
    const audioDue = started.getTime() + 30 * DAY;
    const has = { audio: true, text: true };
    expect(retentionNotice(meeting, SETTINGS, has, new Date(audioDue - 8 * DAY))).toBeNull();
    expect(retentionNotice(meeting, SETTINGS, has, new Date(audioDue - 7 * DAY))).toEqual({
      kind: 'audio',
      at: new Date(audioDue),
      overdue: false,
    });
    expect(retentionNotice(meeting, SETTINGS, has, new Date(audioDue + 1))?.overdue).toBe(true);
  });

  it('says nothing for a kept meeting, or for what is already gone', () => {
    const near = new Date(started.getTime() + 29 * DAY);
    expect(
      retentionNotice({ ...meeting, keep: true }, SETTINGS, { audio: true, text: true }, near),
    ).toBeNull();
    // Audio already gone, the transcript far away: nothing to announce.
    expect(retentionNotice(meeting, SETTINGS, { audio: false, text: true }, near)).toBeNull();
    // Only audio left, and it goes: that is everything.
    expect(retentionNotice(meeting, SETTINGS, { audio: true, text: false }, near)?.kind).toBe(
      'all',
    );
    const both = retentionNotice(
      meeting,
      { retentionAudioDays: 30, retentionTranscriptDays: 32 },
      { audio: true, text: true },
      near,
    );
    expect(both).toEqual({
      kind: 'all',
      at: new Date(started.getTime() + 30 * DAY),
      overdue: false,
    });
  });
});

describe('retentionBatch', () => {
  it('deletes audio past its deadline and leaves the transcript', async () => {
    const t = setup();
    await t.full('m40', 40);
    const result = await t.run();
    expect(result).toMatchObject({
      meetings: 1,
      audioDeleted: 1,
      textDeleted: 0,
      markedDeleted: 0,
      more: false,
    });
    expect(t.deleted).toEqual(['recordings/test/m40/m40-r.webm']);
    expect(t.recording('m40')).toEqual({ storage_path: '', delete_audio_at: NOW.getTime() });
    expect(t.count('segments', 'm40')).toBe(2);
    expect(t.meeting('m40')?.deleted_at).toBeNull();
    // The next night has nothing to do for it.
    expect((await t.run()).meetings).toBe(0);
  });

  it('deletes transcript, recap, versions, decisions and their search rows past the second deadline, and marks the meeting', async () => {
    const t = setup();
    await t.full('m400', 400);
    const result = await t.run();
    expect(result).toMatchObject({
      meetings: 1,
      audioDeleted: 1,
      textDeleted: 1,
      markedDeleted: 1,
    });
    expect(t.deleted.sort()).toEqual(['exports/m400.docx', 'recordings/test/m400/m400-r.webm']);
    for (const table of [
      'segments',
      'transcripts',
      'recaps',
      'recap_versions',
      'decisions',
      'meeting_search',
    ]) {
      expect(t.count(table, 'm400'), table).toBe(0);
    }
    // The metadata row stays, marked; its title stays searchable for the owner.
    expect(t.meeting('m400')?.deleted_at).toBe(NOW.getTime());
    expect(t.count('recordings', 'm400')).toBe(1);
  });

  it('leaves kept meetings, recent meetings and open uploads alone', async () => {
    const t = setup();
    await t.full('kept', 400, true);
    await t.full('recent', 10);
    t.f.meeting('uploading', { owner: 'owner', startedAt: ago(400) });
    t.f.recording('uploading-r', 'uploading', { status: 'uploading' });
    const result = await t.run();
    expect(result.meetings).toBe(0);
    expect(t.deleted).toEqual([]);
  });

  it('marks a meeting with nothing left once both deadlines pass', async () => {
    const t = setup();
    t.f.meeting('empty-old', { owner: 'owner', startedAt: ago(366) });
    t.f.meeting('empty-young', { owner: 'owner', startedAt: ago(100) });
    await t.run();
    expect(t.meeting('empty-old')?.deleted_at).toBe(NOW.getTime());
    expect(t.meeting('empty-young')?.deleted_at).toBeNull();
  });

  it('does not touch a meeting that another install’s rows hang off', async () => {
    const t = setup();
    await t.full('mixed', 400);
    t.sqlite.exec(
      "INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('foreign-s', 'other', 'mixed', 'X')",
    );
    expect((await t.run()).meetings).toBe(0);
    expect(t.count('segments', 'mixed')).toBe(2);
  });

  it('works in batches and says when there is more', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.f.meeting(`b${i}`, { owner: 'owner', startedAt: ago(40 + i) });
      t.f.recording(`b${i}-r`, `b${i}`);
    }
    const first = await t.run(2);
    expect(first).toMatchObject({ meetings: 2, more: true });
    const second = await t.run(2);
    expect(second).toMatchObject({ meetings: 2, more: true });
    const third = await t.run(2);
    expect(third).toMatchObject({ meetings: 1, more: false });
    // Oldest first, each object once.
    expect(t.deleted).toEqual([4, 3, 2, 1, 0].map((i) => `recordings/test/b${i}/b${i}-r.webm`));
    expect((await t.run(2)).meetings).toBe(0);
  });

  it('a Keep set while the batch runs wins: the second meeting keeps its audio and its row', async () => {
    const t = setup();
    for (const id of ['first', 'second']) {
      t.f.meeting(id, { owner: 'owner', startedAt: ago(id === 'first' ? 401 : 400) });
      t.f.recording(`${id}-r`, id);
    }
    // The reviewer's sequence: Keep lands on "second" while the first object deletion is awaited.
    const deleted: string[] = [];
    const storage = {
      list: async () => [] as string[],
      delete: async (keys: string | string[]) => {
        deleted.push(...[keys].flat());
        t.sqlite.exec("UPDATE meetings SET keep = 1 WHERE id = 'second'");
      },
    };
    const result = await retentionBatch({ db: t.db, storage, installId: INSTALL }, SETTINGS, NOW);
    expect(result.meetings).toBe(2);
    expect(deleted).toEqual(['recordings/test/first/first-r.webm']);
    expect(t.recording('second')).toEqual({
      storage_path: 'recordings/test/second/second-r.webm',
      delete_audio_at: null,
    });
    expect(t.meeting('second')?.deleted_at).toBeNull();
    expect(t.meeting('first')?.deleted_at).toBe(NOW.getTime());
    expect(result.skipped).toEqual([{ id: 'second', reason: 'changed' }]);
  });

  it('a Keep set before the transcript batch keeps every transcript row', async () => {
    const t = setup();
    await t.full('kept-late', 400);
    const storage = {
      list: async () => [] as string[],
      delete: async () => {
        // The audio went; then the owner pressed Keep before the transcript batch.
        t.sqlite.exec("UPDATE meetings SET keep = 1 WHERE id = 'kept-late'");
      },
    };
    await retentionBatch({ db: t.db, storage, installId: INSTALL }, SETTINGS, NOW);
    for (const table of [
      'segments',
      'transcripts',
      'recaps',
      'recap_versions',
      'decisions',
      'meeting_search',
    ]) {
      expect(t.count(table, 'kept-late'), table).toBeGreaterThan(0);
    }
    expect(t.meeting('kept-late')?.deleted_at).toBeNull();
  });

  it('puts the audio paths back when storage refuses, so the next try finds them', async () => {
    const t = setup();
    t.f.meeting('m', { owner: 'owner', startedAt: ago(40) });
    t.f.recording('m-r', 'm');
    const storage = {
      list: async () => [] as string[],
      delete: async () => Promise.reject(new Error('R2 down')),
    };
    await expect(
      retentionBatch({ db: t.db, storage, installId: INSTALL }, SETTINGS, NOW),
    ).rejects.toThrow('R2 down');
    expect(t.recording('m')).toEqual({
      storage_path: 'recordings/test/m/m-r.webm',
      delete_audio_at: null,
    });
    expect((await t.run()).audioDeleted).toBe(1);
  });

  it('lists the meetings it leaves alone, with the reason', async () => {
    const t = setup();
    await t.full('kept', 400, true);
    t.f.meeting('uploading', { owner: 'owner', startedAt: ago(400) });
    t.f.recording('uploading-r', 'uploading', { status: 'uploading' });
    await t.full('mixed', 400);
    t.sqlite.exec(
      "INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('foreign-s', 'other', 'mixed', 'X')",
    );
    await t.full('recent', 10, true);
    const result = await retentionBatch(
      {
        db: t.db,
        storage: { list: async () => [] as string[], delete: async () => {} },
        installId: INSTALL,
      },
      SETTINGS,
      NOW,
      100,
      { reportSkips: true },
    );
    expect(result.meetings).toBe(0);
    expect(result.skipped.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'kept', reason: 'keep' },
      { id: 'mixed', reason: 'foreign_rows' },
      { id: 'uploading', reason: 'open_upload' },
    ]);
  });

  it('lists every skip, past any page size, with exact counts per reason', async () => {
    const t = setup();
    // The reviewer's case: 1,004 kept, one open upload, one with foreign rows.
    t.sqlite.exec('BEGIN');
    for (let i = 0; i < 1004; i++) {
      t.f.meeting(`k${String(i).padStart(4, '0')}`, {
        owner: 'owner',
        startedAt: ago(400 + (i % 7)),
        keep: true,
      });
    }
    t.sqlite.exec('COMMIT');
    t.f.meeting('uploading', { owner: 'owner', startedAt: ago(400) });
    t.f.recording('uploading-r', 'uploading', { status: 'uploading' });
    t.f.meeting('mixed', { owner: 'owner', startedAt: ago(400) });
    t.sqlite.exec(
      "INSERT INTO speakers (id, install_id, meeting_id, label) VALUES ('foreign-s', 'other', 'mixed', 'X')",
    );
    const result = await retentionBatch(
      {
        db: t.db,
        storage: { list: async () => [] as string[], delete: async () => {} },
        installId: INSTALL,
      },
      SETTINGS,
      NOW,
      100,
      { reportSkips: true },
    );
    expect(result.skipped).toHaveLength(1006);
    expect(new Set(result.skipped.map((s) => s.id)).size).toBe(1006);
    const counts = result.skipped.reduce<Record<string, number>>(
      (n, s) => ({ ...n, [s.reason]: (n[s.reason] ?? 0) + 1 }),
      {},
    );
    expect(counts).toEqual({ keep: 1004, open_upload: 1, foreign_rows: 1 });
  });

  it("deletes the providers' raw results with the transcripts, comparison transcripts included", async () => {
    const t = setup();
    await t.full('raw', 400);
    t.sqlite.exec(
      "UPDATE transcripts SET raw_path = 'transcripts/test/raw-r/assemblyai-x.json' WHERE id = 'raw-t'",
    );
    t.sqlite.exec(
      "INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, is_comparison, raw_path) VALUES ('raw-cmp', 'test', 'raw-r', 'workers-ai', 'whisper', 'da', '{}', 1, 'transcripts/test/raw-r/workers-ai-y.json')",
    );
    await t.run();
    expect(t.deleted.sort()).toEqual([
      'exports/raw.docx',
      'recordings/test/raw/raw-r.webm',
      'transcripts/test/raw-r/assemblyai-x.json',
      'transcripts/test/raw-r/workers-ai-y.json',
    ]);
    expect(
      rows(t.sqlite, "select count(*) as n from transcripts where recording_id = 'raw-r'"),
    ).toEqual([{ n: 0 }]);
    expect(rows(t.sqlite, 'select count(*) as n from storage_cleanup')).toEqual([{ n: 0 }]);
  });
});
