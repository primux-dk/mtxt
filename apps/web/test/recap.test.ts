import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { seal, type Db } from '@mtxt/adapters';
import { decisionRows, liftDecisions } from '../lib/recap/decisions';
import { fakeDraft } from '../lib/recap/fake-llm';
import { chunkedNote, MAX_ATTEMPTS, runRecap, type RecapDeps } from '../lib/recap/job';
import { RecapError, recapLlm, type RecapLlm } from '../lib/recap/llm';
import { parseMarkdown, toMarkdown } from '../lib/recap/markdown';
import { RECAP_MAX_TOKENS } from '../lib/recap/models';
import {
  buildPlan,
  cleanAnswer,
  estimateTokens,
  splitLines,
  systemPrompt,
  transcriptLines,
} from '../lib/recap/prompt';
import {
  beginDraft,
  listDecisions,
  listVersions,
  loadRecap,
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
  it('keeps the template whole and writes the transcript as Speaker: text with a minute line', () => {
    const plan = buildPlan({
      template: TEMPLATE,
      segments: segments(7),
      keyterms: ['linje 2'],
      language: 'da',
      contextTokens: 131_000,
    });
    expect(plan.kind).toBe('single');
    if (plan.kind !== 'single') return;
    expect(plan.call.maxTokens).toBe(RECAP_MAX_TOKENS);
    expect(plan.call.user).toContain(TEMPLATE.trim());
    expect(plan.call.user.indexOf(TEMPLATE.trim())).toBeLessThan(
      plan.call.user.indexOf('Transcript:'),
    );
    expect(plan.call.user).toContain('[00:00]\nJonas Skov: Sætning nummer 1');
    expect(plan.call.user).toContain('[01:00]\nAnne Holm: Sætning nummer 4');
    expect(plan.call.system).toContain('Write in Danish');
    expect(plan.call.system).toContain('keep every heading of the template');
    expect(plan.call.system).toContain('(unclear)');
    expect(plan.call.system).toContain('Do not invent');
    expect(plan.call.system).toContain('linje 2');
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

  it('summarises a transcript too long for the context in parts, then drafts from the summaries', () => {
    const many = segments(4000);
    const plan = buildPlan({
      template: TEMPLATE,
      segments: many,
      keyterms: [],
      language: 'da',
      contextTokens: 24_000,
    });
    expect(plan.kind).toBe('chunked');
    if (plan.kind !== 'chunked') return;
    expect(plan.parts.length).toBeGreaterThan(2);
    for (const part of plan.parts) {
      expect(estimateTokens(part.system + part.user) + part.maxTokens).toBeLessThanOrEqual(24_000);
      // Every part says when it starts.
      expect(part.user.split('\n')[2]).toMatch(/^\[\d/);
    }
    // Every line is in exactly one part (minute lines may repeat at a part's start).
    const all = plan.parts
      .flatMap((p) => p.user.split('\n').slice(2))
      .filter((l) => !l.startsWith('['));
    expect(all).toHaveLength(4000);
    const draft = plan.draft(plan.parts.map((_, i) => `Resumé ${i + 1}`));
    expect(draft.user).toContain(TEMPLATE.trim());
    expect(draft.user).toContain(`summaries of its ${plan.parts.length} parts`);
    expect(draft.maxTokens).toBe(RECAP_MAX_TOKENS);
  });

  it('splits by line and never splits a line', () => {
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
