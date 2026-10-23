import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { seal, type Db } from '@mtxt/adapters';
import { decisionRows, liftDecisions } from '../lib/recap/decisions';
import { fakeDraft } from '../lib/recap/fake-llm';
import { chunkedNote, draftRecap, MAX_ATTEMPTS, runRecap, type RecapDeps } from '../lib/recap/job';
import { RecapError, recapLlm, type Completion, type RecapLlm } from '../lib/recap/llm';
import { parseMarkdown, toMarkdown } from '../lib/recap/markdown';
import { RECAP_MAX_TOKENS } from '../lib/recap/models';
import {
  callTokens,
  cleanAnswer,
  splitLine,
  splitLines,
  SUMMARY_HEADING,
  systemPrompt,
  transcriptLines,
  type Call,
  type PromptInput,
} from '../lib/recap/prompt';
import {
  beginDraft,
  listDecisions,
  listVersions,
  loadRecap,
  MAX_BODY_CHARS,
  RecapTooLongError,
  writeVersion,
} from '../lib/recap/store';
import { INSTALL, seedRecording, testDb } from './sqlite-db';

vi.mock('../lib/install', () => ({}));

const TEMPLATE = `# Produktionsmøde

## Status

## Beslutninger

## Næste skridt
`;

const segments = (n: number, every = 20_000) =>
  Array.from({ length: n }, (_, i) => ({
    startMs: i * every,
    speaker: i % 2 ? 'Anne Holm' : 'Jonas Skov',
    text: `Sætning nummer ${i + 1} om linje 2 og kapaciteten.`,
  }));

describe('the prompt builder', () => {
  const input = (over: Partial<PromptInput> = {}): PromptInput => ({
    template: TEMPLATE,
    segments: segments(7),
    keyterms: ['linje 2'],
    language: 'da',
    contextTokens: 131_000,
    ...over,
  });
  /** A model that answers from the request, and records every call. */
  const recording = (answer?: (call: Call) => Completion) => {
    const calls: Call[] = [];
    const llm: RecapLlm = {
      provider: 'workers-ai',
      model: 'test',
      async complete(call) {
        calls.push(call);
        if (answer) return answer(call);
        return call.user.startsWith('Part ')
          ? { text: `Resumé: ${call.user.slice(0, 200)}`, truncated: false }
          : { text: fakeDraft(call.user), truncated: false };
      },
    };
    return { llm, calls };
  };

  it('keeps the template whole and writes the transcript as Speaker: text with a minute line', async () => {
    const { llm, calls } = recording();
    await draftRecap(llm, input());
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.maxTokens).toBe(RECAP_MAX_TOKENS);
    expect(call.user).toContain(TEMPLATE.trim());
    expect(call.user.indexOf(TEMPLATE.trim())).toBeLessThan(call.user.indexOf('Transcript:'));
    expect(call.user).toContain('[00:00]\nJonas Skov: Sætning nummer 1');
    expect(call.user).toContain('[01:00]\nAnne Holm: Sætning nummer 4');
    expect(call.system).toContain('Write in Danish');
    expect(call.system).toContain('keep every heading of the template');
    expect(call.system).toContain('(unclear)');
    expect(call.system).toContain('Do not invent');
    expect(call.system).toContain('linje 2');
  });

  it('puts a minute line only when the minute changes, and drops empty segments', () => {
    expect(
      transcriptLines([
        { startMs: 0, speaker: 'A', text: 'en' },
        { startMs: 30_000, speaker: null, text: 'to' },
        { startMs: 31_000, speaker: 'B', text: '   ' },
        { startMs: 3_660_000, speaker: 'B', text: 'tre' },
      ]),
    ).toEqual(['[00:00]', 'A: en', 'to', '[1:01:00]', 'B: tre']);
  });

  it('summarises a transcript too long for the context in parts, then drafts from the summaries', async () => {
    const { llm, calls } = recording();
    const out = await draftRecap(llm, input({ segments: segments(4000), contextTokens: 24_000 }));
    const parts = calls.filter((c) => c.user.startsWith('Part '));
    expect(parts.length).toBeGreaterThan(2);
    for (const call of calls) expect(callTokens(call)).toBeLessThanOrEqual(24_000);
    for (const part of parts) expect(part.user.split('\n')[2]).toMatch(/^\[\d/);
    // Every line is in exactly one part (minute lines may repeat at a part's start).
    const all = parts.flatMap((p) => p.user.split('\n').slice(2)).filter((l) => !l.startsWith('['));
    expect(all).toHaveLength(4000);
    const final = calls.at(-1)!;
    expect(final.user).toContain(TEMPLATE.trim());
    expect(final.user).toContain(SUMMARY_HEADING);
    expect(out.note).toBe(chunkedNote(parts.length));
  });

  it('fits one 41,500-word segment into a 24,000-token model, cut at sentences', async () => {
    const words = Array.from({ length: 41_500 }, (_, i) =>
      i % 12 === 11 ? 'ordren.' : 'kapacitet',
    );
    const { llm, calls } = recording();
    await draftRecap(
      llm,
      input({
        segments: [{ startMs: 0, speaker: 'Jonas Skov', text: words.join(' ') }],
        contextTokens: 24_000,
      }),
    );
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(callTokens(call)).toBeLessThanOrEqual(24_000);
    // The pieces end at sentences and keep the speaker.
    const first = calls[0]!.user.split('\n')[3]!;
    expect(first).toMatch(/^Jonas Skov: kapacitet/);
    expect(first).toMatch(/ordren\.$/);
  });

  it('summarises the summaries until the final call fits beside a 19,992-character template', async () => {
    const template = `# Referat\n\n${'## Afsnit med en lang forklaring\n\n'.repeat(1000)}`.slice(
      0,
      19_992,
    );
    // Summaries as long as the cap allows, so one round is not enough.
    const { llm, calls } = recording((call) =>
      call.user.startsWith('Part ')
        ? { text: 'resumé '.repeat(500), truncated: false }
        : { text: template, truncated: false },
    );
    await draftRecap(llm, input({ template, segments: segments(20_000), contextTokens: 24_000 }));
    for (const call of calls) expect(callTokens(call)).toBeLessThanOrEqual(24_000);
    expect(calls.some((c) => c.user.includes('of the summaries of the transcript'))).toBe(true);
  });

  it('fails with a fixed reason when the template cannot fit even alone', async () => {
    const { llm } = recording();
    await expect(
      draftRecap(llm, input({ template: '# A\n'.repeat(30_000), contextTokens: 24_000 })),
    ).rejects.toMatchObject({ reason: 'template_too_long' });
  });

  it('tries a cut-off draft once more with half the room, then fails as incomplete', async () => {
    let n = 0;
    const once = recording((call) =>
      n++ === 0
        ? { text: '# Produktionsmøde\n\n## Status\n', truncated: true }
        : { text: fakeDraft(call.user), truncated: false },
    );
    const out = await draftRecap(once.llm, input());
    expect(once.calls).toHaveLength(2);
    expect(out.markdown).toContain('## Næste skridt');
    const always = recording(() => ({ text: '# Produktionsmøde\n', truncated: true }));
    await expect(draftRecap(always.llm, input())).rejects.toMatchObject({
      reason: 'incomplete_draft',
    });
    expect(always.calls).toHaveLength(2);
  });

  it("refuses a draft that lacks one of the template's headings", async () => {
    const missing = recording(() => ({
      text: '# Produktionsmøde\n\n## Status\n\nOK.\n',
      truncated: false,
    }));
    await expect(draftRecap(missing.llm, input())).rejects.toMatchObject({
      reason: 'incomplete_draft',
    });
    // The plain template asks for no headings: the model may write them in the transcript's language.
    const plain = recording(() => ({ text: '# Resumé\n\nOK.\n', truncated: false }));
    expect((await draftRecap(plain.llm, input({ template: '' }))).markdown).toBe('# Resumé\n\nOK.');
  });

  it('splits a line too long for a part at sentence ends', () => {
    expect(splitLine('A: En. To. Tre.', 3)).toEqual(['A: En.', 'A: To.', 'A: Tre.']);
    expect(splitLines(['[00:00]', 'a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], 25)).toEqual([
      ['[00:00]', 'a'.repeat(30)],
      ['[00:00]', 'b'.repeat(30)],
      ['[00:00]', 'c'.repeat(30)],
    ]);
  });

  it('writes in the transcript language when it is unknown, and unwraps a fenced answer', () => {
    expect(systemPrompt('auto', [])).toContain('Write in the language of the transcript.');
    expect(cleanAnswer('```markdown\n# Referat\n\nTekst\n```')).toBe('# Referat\n\nTekst');
  });
});

describe('lifting decisions', () => {
  const speakers = [
    { id: 'sp-1', name: 'Anne Holm', userId: 'u-anne' },
    { id: 'sp-2', name: 'Speaker 3', userId: null },
    { id: 'sp-3', name: 'Anne', userId: 'u-other' },
  ];

  it("makes the first checklist the decisions block, with the speakers' names as mentions", () => {
    const md = `# Referat\n\nAnne Holm og @Anne talte.\n\n## Beslutninger\n\n- [ ] Saml tallene @Anne Holm\n- [x] Test skiftet @Speaker 3\n- [ ] Ingen ejer\n\n## Andet\n\n- [ ] Ikke en beslutning\n`;
    const doc = liftDecisions(parseMarkdown(md), speakers);
    const out = toMarkdown(doc);
    expect(out).toContain(
      '<!-- decisions -->\n- [ ] Saml tallene [@Anne Holm](mtxt:user/u-anne)\n- [x] Test skiftet [@Speaker 3](mtxt:speaker/sp-2)\n- [ ] Ingen ejer\n<!-- /decisions -->',
    );
    // The longest name wins, and "@Anne" alone is a different colleague.
    expect(out).toContain('Anne Holm og [@Anne](mtxt:user/u-other) talte.');
    // Only the first checklist.
    expect(out).toContain('- [ ] Ikke en beslutning');
    const rows = decisionRows(doc, new Map([['sp-2', 'u-linked']]));
    expect(rows).toEqual([
      { position: 0, text: 'Saml tallene @Anne Holm', ownerUserId: 'u-anne', done: false },
      { position: 1, text: 'Test skiftet @Speaker 3', ownerUserId: 'u-linked', done: true },
      { position: 2, text: 'Ingen ejer', ownerUserId: null, done: false },
    ]);
  });

  it('leaves a draft with no checklist alone, and a block that is already there', () => {
    const plain = liftDecisions(parseMarkdown('# Referat\n\nTekst.\n'), speakers);
    expect(decisionRows(plain)).toEqual([]);
    const md =
      '<!-- decisions -->\n- [ ] Allerede her\n<!-- /decisions -->\n\n- [ ] En anden liste\n';
    expect(toMarkdown(liftDecisions(parseMarkdown(md), speakers))).toBe(md);
  });

  it('does not mention inside code or inside a longer word', () => {
    const doc = liftDecisions(parseMarkdown('Skriv `@Anne Holm` og @Annette.\n'), speakers);
    expect(toMarkdown(doc)).toBe('Skriv `@Anne Holm` og @Annette.\n');
  });
});

/** A meeting with a done transcript: three speakers, one linked. */
function seedTranscript(raw: DatabaseSync, meetingId = 'meet-1') {
  seedRecording(raw, `rec-${meetingId}`, meetingId);
  raw.exec(`INSERT OR IGNORE INTO users (id, install_id, oidc_subject, email, name) VALUES
      ('u-anne', '${INSTALL}', 'sub-anne', 'anne@example.com', 'Anne Holm');
    UPDATE recordings SET status = 'transcribed', is_primary = 1 WHERE id = 'rec-${meetingId}';
    INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status)
      VALUES ('tr-${meetingId}', '${INSTALL}', 'rec-${meetingId}', 'assemblyai', 'u', 'da', '{}', 'done');
    INSERT INTO speakers (id, install_id, meeting_id, label, user_id, speaker_index) VALUES
      ('sp-a-${meetingId}', '${INSTALL}', '${meetingId}', 'Speaker 1', 'u-anne', 0),
      ('sp-b-${meetingId}', '${INSTALL}', '${meetingId}', 'Jonas Skov', null, 1);
    INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES
      ('g1-${meetingId}', '${INSTALL}', 'tr-${meetingId}', 'sp-a-${meetingId}', 0, 1000, 'Vi tester skiftet torsdag.'),
      ('g2-${meetingId}', '${INSTALL}', 'tr-${meetingId}', 'sp-b-${meetingId}', 61000, 62000, 'Jeg samler tallene.');
    INSERT INTO templates (id, install_id, name, name_key, body_md, is_default) VALUES
      ('tpl-1', '${INSTALL}', 'Produktionsmøde', 'produktionsmøde', '# Produktionsmøde\n\n## Status\n\n## Beslutninger\n', 1);`);
}

const fakeLlm = (complete: RecapLlm['complete']): RecapLlm => ({
  provider: 'workers-ai',
  model: '@cf/meta/llama-4-scout-17b-16e-instruct',
  complete,
});

function deps(db: Db, llm: RecapLlm, taken = new Set<string>()): RecapDeps {
  return {
    db,
    installId: INSTALL,
    llm: async () => llm,
    takeOnce: async (id) => (taken.has(id) ? false : (taken.add(id), true)),
    log: { log: () => {}, error: () => {} },
  };
}

const job = (meetingId = 'meet-1', draftToken?: string) => ({
  type: 'recap' as const,
  meeting_id: meetingId,
  transcript_id: `tr-${meetingId}`,
  install_id: INSTALL,
  ...(draftToken ? { draft_token: draftToken } : {}),
});

describe('the recap job', () => {
  it('drafts version 1 with no author from the template, and lifts the decisions', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const calls: string[] = [];
    const llm = fakeLlm(async (call) => {
      calls.push(call.user);
      return { text: fakeDraft(call.user), truncated: false };
    });
    await runRecap(deps(db, llm), job(), 1);
    expect(calls[0]).toContain('# Produktionsmøde');
    expect(calls[0]).toContain('Anne Holm: Vi tester skiftet torsdag.');
    const recap = await loadRecap(db, INSTALL, 'meet-1');
    expect(recap?.status).toBe('ready');
    expect(recap?.current).toMatchObject({ number: 1, authorId: null, note: null });
    expect(recap?.current?.bodyMd).toContain('## Beslutninger');
    expect(recap?.current?.bodyMd).toContain('[@Anne Holm](mtxt:user/u-anne)');
    const rows = await listDecisions(db, INSTALL, recap!.id);
    expect(rows.map((r) => [r.text, r.ownerUserId, r.done])).toEqual([
      ['Vi tester skiftet torsdag. @Anne Holm', 'u-anne', false],
      ['Jeg samler tallene. @Jonas Skov', null, false],
    ]);
    // The search index has the recap's text, not its markdown.
    const indexed = raw
      .prepare(`select text from meeting_search where kind = 'recap' and meeting_id = 'meet-1'`)
      .all() as { text: string }[];
    expect(indexed[0]?.text).toContain('@Anne Holm');
    expect(indexed[0]?.text).not.toContain('mtxt:');
    // The same transcript's job again changes nothing.
    await runRecap(deps(db, llm, new Set(['tr-meet-1'])), job(), 1);
    expect(await listVersions(db, INSTALL, recap!.id)).toHaveLength(1);
  });

  it('says in the version note when it drafted from summaries of parts', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    raw.exec(`INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text)
      SELECT 'x' || value, '${INSTALL}', 'tr-meet-1', 'sp-b-meet-1', value * 2000, value * 2000 + 1000,
        'En meget lang sætning om kapacitet, ordrer og planer for linje 2 nummer ' || value
      FROM json_each('[${Array.from({ length: 3000 }, (_, i) => i + 100).join(',')}]')`);
    let calls = 0;
    const llm: RecapLlm = {
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      async complete(call) {
        calls++;
        return {
          text: call.user.startsWith('Part ') ? 'Resumé.' : fakeDraft(call.user),
          truncated: false,
        };
      },
    };
    await runRecap(deps(db, llm), job(), 1);
    const recap = await loadRecap(db, INSTALL, 'meet-1');
    expect(calls).toBeGreaterThan(2);
    expect(recap?.current?.note).toBe(chunkedNote(calls - 1));
  });

  it('fails with a fixed reason, retries what is worth it, and Try again drafts anew', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const failing = fakeLlm(async () => {
      throw new RecapError('rate_limited', true, 429);
    });
    // A retryable error goes back to the queue until the last attempt.
    await expect(runRecap(deps(db, failing), job(), 1)).rejects.toThrow(RecapError);
    expect((await loadRecap(db, INSTALL, 'meet-1'))?.status).toBe('drafting');
    await runRecap(deps(db, failing, new Set(['tr-meet-1'])), job(), MAX_ATTEMPTS);
    const failed = await loadRecap(db, INSTALL, 'meet-1');
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: 'rate_limited:429',
      current: null,
    });

    // Try again: the owner's action starts a draft with a token, the message carries it.
    const started = await beginDraft(db, INSTALL, 'meet-1', null);
    const ok = fakeLlm(async (call) => ({ text: fakeDraft(call.user), truncated: false }));
    await runRecap(deps(db, ok), job('meet-1', started!.token), 1);
    expect((await loadRecap(db, INSTALL, 'meet-1'))?.current?.number).toBe(1);
  });

  it('never stores a cut-off draft: the recap fails as incomplete_draft with no version', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const cut = fakeLlm(async () => ({
      text: '# Produktionsmøde\n\n## Status\n\nVi',
      truncated: true,
    }));
    await runRecap(deps(db, cut), job(), 1);
    expect(await loadRecap(db, INSTALL, 'meet-1')).toMatchObject({
      status: 'failed',
      failureReason: 'incomplete_draft',
      current: null,
    });
  });

  it('regenerates on top of a human version, and an older draft cannot write over a newer one', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const ok = fakeLlm(async (call) => ({ text: fakeDraft(call.user), truncated: false }));
    await runRecap(deps(db, ok), job(), 1);
    const recap = (await loadRecap(db, INSTALL, 'meet-1'))!;
    const human = await writeVersion(db, INSTALL, {
      recapId: recap.id,
      meetingId: 'meet-1',
      bodyMd: '# Mit referat\n',
      authorId: 'owner',
      base: { versionId: recap.current!.id },
    });
    expect(human.ok).toBe(true);
    const first = await beginDraft(db, INSTALL, 'meet-1', null, { now: 1 });
    const second = await beginDraft(db, INSTALL, 'meet-1', null, { now: 2 });
    await runRecap(deps(db, ok), job('meet-1', first!.token), 1);
    await runRecap(deps(db, ok), job('meet-1', second!.token), 1);
    const versions = await listVersions(db, INSTALL, recap.id);
    expect(versions.map((v) => [v.number, v.authorId])).toEqual([
      [3, null],
      [2, 'owner'],
      [1, null],
    ]);
  });
});

describe('the version conflict rule', () => {
  it('lands a save on the current version and refuses one on a stale base', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const started = (await beginDraft(db, INSTALL, 'meet-1', null))!;
    const v1 = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: '# A\n',
      authorId: null,
      draftToken: started.token,
    });
    if (!v1.ok) throw new Error('v1');
    const tabA = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: '# B\n',
      authorId: 'owner',
      base: { versionId: v1.version.id },
    });
    expect(tabA).toMatchObject({ ok: true, version: { number: 2, authorName: 'Mette Lund' } });
    // The second tab still has v1 as its base.
    const tabB = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: '# C\n',
      authorId: 'owner',
      base: { versionId: v1.version.id },
    });
    expect(tabB).toMatchObject({
      ok: false,
      reason: 'conflict',
      current: { number: 2, authorName: 'Mette Lund' },
    });
    const recap = await loadRecap(db, INSTALL, 'meet-1');
    expect(recap?.current?.bodyMd).toBe('# B\n');
    // A first save with no base is refused once a version exists.
    expect(
      await writeVersion(db, INSTALL, {
        recapId: started.recapId,
        meetingId: 'meet-1',
        bodyMd: '# D\n',
        authorId: 'owner',
        base: { versionId: null },
      }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it("writes the decisions rows from each version's body", async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const started = (await beginDraft(db, INSTALL, 'meet-1', null))!;
    const body = (checked: string) =>
      `<!-- decisions -->\n- [${checked}] Test [@Jonas Skov](mtxt:speaker/sp-b-meet-1)\n<!-- /decisions -->\n`;
    const v1 = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: body(' '),
      authorId: null,
      draftToken: started.token,
    });
    if (!v1.ok) throw new Error('v1');
    raw.exec(`UPDATE speakers SET user_id = 'u-anne' WHERE id = 'sp-b-meet-1'`);
    await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: body('x'),
      authorId: 'owner',
      base: { versionId: v1.version.id },
    });
    expect(await listDecisions(db, INSTALL, started.recapId)).toMatchObject([
      { text: 'Test @Jonas Skov', done: true, ownerUserId: 'u-anne', ownerName: 'Anne Holm' },
    ]);
  });
});

describe('the recap model', () => {
  const KEY = Buffer.alloc(32, 5).toString('base64');
  const language = {
    generate: vi.fn(async () => ({ text: '# Referat' })),
    gatewayUrl: vi.fn(
      async (id: string, provider: string) =>
        `https://gateway.ai.cloudflare.com/v1/acct/${id}/${provider}`,
    ),
  };

  it('calls Anthropic through the gateway with the opened key, low effort and the cap', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ content: [{ type: 'text', text: '# Referat' }], stop_reason: 'end_turn' }),
    );
    const llm = await recapLlm(
      {
        recapProvider: 'anthropic',
        recapModel: null,
        recapApiKey: await seal('sk-ant-test', 'settings.recap_api_key', KEY),
        aiGatewayId: 'gw',
      },
      { language, settingsKey: KEY, fetch: fetchMock },
    );
    expect(llm.model).toBe('claude-opus-5-5');
    expect(await llm.complete({ system: 's', user: 'u', maxTokens: 4000 })).toEqual({
      text: '# Referat',
      truncated: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: 's',
      output_config: { effort: 'low' },
    });
  });

  it("maps a provider's status to a fixed reason and never reads its body", async () => {
    const llm = await recapLlm(
      {
        recapProvider: 'openai',
        recapModel: 'gpt-5.4',
        recapApiKey: await seal('k', 'settings.recap_api_key', KEY),
        aiGatewayId: null,
      },
      {
        language,
        settingsKey: KEY,
        fetch: async () => new Response('{"error":"your key k is bad"}', { status: 401 }),
      },
    );
    const error = await llm
      .complete({ system: 's', user: 'u', maxTokens: 10 })
      .catch((e: RecapError) => e);
    expect(error).toBeInstanceOf(RecapError);
    expect((error as RecapError).stored).toBe('unauthorised:401');
    expect((error as RecapError).message).not.toContain('bad');
  });

  it('drafts on Workers AI through the binding with no key', async () => {
    const llm = await recapLlm(
      { recapProvider: 'workers-ai', recapModel: null, recapApiKey: null, aiGatewayId: 'gw' },
      { language, settingsKey: undefined },
    );
    await llm.complete({ system: 's', user: 'u', maxTokens: 4000 });
    expect(language.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: '@cf/meta/llama-4-scout-17b-16e-instruct',
        maxTokens: 4000,
        gatewayId: 'gw',
      }),
    );
  });

  it('refuses a provider that needs a key and has none', async () => {
    await expect(
      recapLlm(
        { recapProvider: 'anthropic', recapModel: null, recapApiKey: null, aiGatewayId: null },
        { language, settingsKey: KEY },
      ),
    ).rejects.toMatchObject({ reason: 'unauthorised' });
  });
});

describe('decision owners stay inside the install (packet 5 review)', () => {
  it('turns a mention of a user of another install, or of nobody, into a plain name with no owner', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    raw.exec(`INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES
      ('foreign-user', 'other-install', 'f', 'f@example.com', 'Fremmed')`);
    const started = (await beginDraft(db, INSTALL, 'meet-1', null))!;
    const body =
      '<!-- decisions -->\n- [ ] Fremmed ejer [@Fremmed](mtxt:user/foreign-user)\n' +
      '- [ ] Ukendt ejer [@Ingen](mtxt:user/no-such-user)\n' +
      '- [ ] Fremmed taler [@Speaker 9](mtxt:speaker/other-meeting-speaker)\n' +
      '- [ ] Rigtig ejer [@Anne Holm](mtxt:user/u-anne)\n<!-- /decisions -->\n';
    const written = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: body,
      authorId: null,
      draftToken: started.token,
    });
    if (!written.ok) throw new Error('not written');
    expect(written.bodyMd).toContain('Fremmed ejer @Fremmed');
    expect(written.bodyMd).toContain('Ukendt ejer @Ingen');
    expect(written.bodyMd).toContain('Fremmed taler @Speaker 9');
    expect(written.bodyMd).not.toContain('foreign-user');
    expect(written.bodyMd).toContain('[@Anne Holm](mtxt:user/u-anne)');
    expect((await listDecisions(db, INSTALL, started.recapId)).map((d) => d.ownerUserId)).toEqual([
      null,
      null,
      null,
      'u-anne',
    ]);
  });

  it('keeps images of this meeting only', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const started = (await beginDraft(db, INSTALL, 'meet-1', null))!;
    const own = '/api/v1/meetings/meet-1/recap/images/0b3f2c1e-7a5d-4c8e-9f10-2a3b4c5d6e7f.png';
    const other = '/api/v1/meetings/meet-2/recap/images/0b3f2c1e-7a5d-4c8e-9f10-2a3b4c5d6e7f.png';
    const written = await writeVersion(db, INSTALL, {
      recapId: started.recapId,
      meetingId: 'meet-1',
      bodyMd: `![Egen](${own})\n\n![Andet møde](${other})\n\n![Fjern](https://example.com/x.png)\n`,
      authorId: null,
      draftToken: started.token,
    });
    if (!written.ok) throw new Error('not written');
    expect(written.bodyMd).toBe(`![Egen](${own})\n\nAndet møde\n\nFjern\n`);
  });
});

describe('the stored-size cap (second review)', () => {
  it('stores 500,000 characters and refuses 500,001 with a typed error', async () => {
    const { db, raw } = await testDb();
    seedTranscript(raw);
    const started = (await beginDraft(db, INSTALL, 'meet-1', null))!;
    const save = (length: number, base: string | null) =>
      writeVersion(db, INSTALL, {
        recapId: started.recapId,
        meetingId: 'meet-1',
        bodyMd: 'x'.repeat(length),
        authorId: 'owner',
        base: { versionId: base },
      });
    await expect(save(MAX_BODY_CHARS + 1, null)).rejects.toBeInstanceOf(RecapTooLongError);
    const ok = await save(MAX_BODY_CHARS, null);
    expect(ok.ok).toBe(true);
  });
});
