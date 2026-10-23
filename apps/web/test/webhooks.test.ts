import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { seal, seedSql, type Db, type HostResolver, type Job } from '@mtxt/adapters';
import { checkEndpointUrl, checkTarget, isPrivateAddress } from '../lib/webhooks/address';
import { linkOrigin, runWebhook, type WebhookDeps } from '../lib/webhooks/deliver';
import { createGrant, readGrant } from '../lib/webhooks/grant';
import { buildPayload } from '../lib/webhooks/payload';
import {
  backoffAfter,
  BACKOFF_S,
  connectedLabel,
  MAX_ATTEMPTS,
  mayBeSent,
} from '../lib/webhooks/rules';
import { newEndpointSecret, signatureHeader, verifySignature } from '../lib/webhooks/signature';
import {
  createEndpoint,
  planDeleted,
  queueCurrentState,
  queueDeleted,
  queueMeetingEvent,
  queueMeetingEventQuietly,
  queueTestEvent,
  retryNow,
  sweepDeliveries,
} from '../lib/webhooks/store';
import { INSTALL, testDb } from '@mtxt/adapters/test/sqlite';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 8).toString('base64');

describe('the signature', () => {
  const secret = 'whsec_test-secret';
  const body = '{"event":"meeting.transcribed"}';

  it('is t=<unix>,v1=<hex> over "<t>.<body>", and verifies', async () => {
    const header = await signatureHeader(secret, body, 1_793_000_000);
    expect(header).toMatch(/^t=1793000000,v1=[0-9a-f]{64}$/);
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', secret).update(`1793000000.${body}`).digest('hex');
    expect(header).toBe(`t=1793000000,v1=${expected}`);
    expect(await verifySignature(header, secret, body, 1_793_000_010)).toBe(true);
  });

  it('refuses a changed body, another secret, an old or future timestamp and a bad header', async () => {
    const header = await signatureHeader(secret, body, 1_793_000_000);
    expect(await verifySignature(header, secret, body + ' ', 1_793_000_000)).toBe(false);
    expect(await verifySignature(header, 'whsec_other', body, 1_793_000_000)).toBe(false);
    expect(await verifySignature(header, secret, body, 1_793_000_301)).toBe(false);
    expect(await verifySignature(header, secret, body, 1_792_999_699)).toBe(false);
    // The timestamp is signed: moving it breaks the MAC.
    const moved = header.replace('t=1793000000', 't=1793000100');
    expect(await verifySignature(moved, secret, body, 1_793_000_100)).toBe(false);
    expect(await verifySignature(null, secret, body)).toBe(false);
    expect(await verifySignature('v1=abc', secret, body)).toBe(false);
  });

  it('makes a fresh secret each time', () => {
    const a = newEndpointSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newEndpointSecret()).not.toBe(a);
  });
});

describe('the export grant', () => {
  const now = new Date('2026-10-23T10:00:00Z');
  const grant = {
    meetingId: '6f1c2a34-1111-4222-8333-944455556666',
    format: 'md' as const,
    endpointId: '0a1b2c3d-1111-4222-8333-944455556666',
    expiresAt: Math.floor(now.getTime() / 1000) + 3600,
  };

  it('reads back what it was made for', async () => {
    const token = await createGrant(KEY, grant);
    expect(token).toMatch(/^v1\.[^.]+\.md\.\d+\.[^.]+\.[A-Za-z0-9_-]{43}$/);
    expect(await readGrant(KEY, token, now)).toEqual({ ok: true, grant });
  });

  it('expires after its hour', async () => {
    const token = await createGrant(KEY, grant);
    expect(await readGrant(KEY, token, new Date(grant.expiresAt * 1000 - 1))).toMatchObject({
      ok: true,
    });
    expect(await readGrant(KEY, token, new Date(grant.expiresAt * 1000))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('is scoped: another meeting, format, endpoint, expiry or key opens nothing', async () => {
    const token = await createGrant(KEY, grant);
    const swap = (from: string, to: string) => token.replace(from, to);
    for (const changed of [
      swap(grant.meetingId, '6f1c2a34-1111-4222-8333-944455556667'),
      swap('.md.', '.docx.'),
      swap('.md.', '.transcript.'),
      swap(grant.endpointId, '0a1b2c3d-1111-4222-8333-944455556667'),
      swap(`.${grant.expiresAt}.`, `.${grant.expiresAt + 3600}.`),
      token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
      'v1.not-a-token',
      '',
    ]) {
      expect(await readGrant(KEY, changed, now), changed).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await readGrant(OTHER_KEY, token, now)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('outbound addresses', () => {
  it('takes https URLs up to 2,048 characters and nothing else', () => {
    const long = `https://alex.example.com/hooks/${'a'.repeat(2048 - 31)}`;
    expect(long).toHaveLength(2048);
    expect(checkEndpointUrl(long).ok).toBe(true);
    expect(checkEndpointUrl(long + 'a')).toEqual({ ok: false, problem: 'too_long' });
    expect(checkEndpointUrl('http://alex.example.com/hook')).toEqual({
      ok: false,
      problem: 'not_https',
    });
    expect(checkEndpointUrl('https://alex.example.com:443/hook').ok).toBe(true);
    for (const port of [80, 22, 8443]) {
      expect(checkEndpointUrl(`https://alex.example.com:${port}/hook`)).toEqual({
        ok: false,
        problem: 'port',
      });
    }
    expect(checkEndpointUrl('https://user:pw@alex.example.com/')).toEqual({
      ok: false,
      problem: 'credentials',
    });
    expect(checkEndpointUrl('not a url')).toEqual({ ok: false, problem: 'invalid' });
    for (const host of [
      'localhost',
      'api.localhost',
      'alex.internal',
      'printer.local',
      'intranet',
      '127.0.0.1',
      '10.1.2.3',
      '[::1]',
      '[fd00::1]',
      '169.254.169.254',
      '2130706433', // 127.0.0.1, as the URL parser reads it
    ]) {
      expect(checkEndpointUrl(`https://${host}/hook`), host).toEqual({
        ok: false,
        problem: 'private_host',
      });
    }
  });

  it('lets the e2e receiver through only when allowed', () => {
    const url = 'http://localhost:8788/api/test/webhook-receiver';
    expect(checkEndpointUrl(url).ok).toBe(false);
    expect(checkEndpointUrl(url, { allowLocal: true }).ok).toBe(true);
    expect(checkEndpointUrl('http://alex.example.com/', { allowLocal: true }).ok).toBe(false);
  });

  it('knows a private address from a public one', () => {
    for (const ip of [
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      '64:ff9b::a00:1',
      '2002:c0a8:101::1',
      'garbage',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '192.169.0.1',
      '100.128.0.1',
      '2606:4700:4700::1111',
      '::ffff:1.1.1.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('resolves the host and refuses a private answer, an empty one, a short TTL and a failed lookup', async () => {
    const resolver = (answers: Record<string, string[] | Error>): HostResolver => ({
      async resolve(host) {
        const answer = answers[host];
        if (answer instanceof Error) throw answer;
        return (answer ?? []).map((a) => {
          const [address, ttl] = a.split('/');
          return { address: address!, ttl: ttl ? Number(ttl) : 300 };
        });
      },
    });
    const r = resolver({
      'alex.example.com': ['93.184.216.34'],
      'fast.example.com': ['93.184.216.34/59'],
      'sixty.example.com': ['93.184.216.34/60'],
      'rebind.example.com': ['93.184.216.34', '10.0.0.5'],
      'six.example.com': ['::1'],
      'broken.example.com': new Error('SERVFAIL'),
    });
    const target = (host: string) => checkTarget(new URL(`https://${host}/hook`), r);
    expect(await target('alex.example.com')).toBeNull();
    expect(await target('fast.example.com')).toBe('short_ttl');
    expect(await target('sixty.example.com')).toBeNull();
    expect(await target('rebind.example.com')).toBe('private_address');
    expect(await target('six.example.com')).toBe('private_address');
    expect(await target('nothing.example.com')).toBe('dns');
    expect(await target('broken.example.com')).toBe('dns');
    expect(await target('alex.internal')).toBe('private_address');
    expect(await target('93.184.216.34')).toBeNull();
  });
});

describe('the rules', () => {
  it('makes six attempts: the first and five retries after 1 min, 10 min, 1 h, 6 h and 24 h, then parks', () => {
    expect(BACKOFF_S).toEqual([60, 600, 3600, 21_600, 86_400]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffAfter)).toEqual([
      60,
      600,
      3600,
      21_600,
      86_400,
      null,
      null,
    ]);
  });

  it('never sends a private meeting automatically; consent sends any', () => {
    const at = (visibility: 'private' | 'shared' | 'company', consent = false) => ({
      visibility,
      webhookConsentAt: consent ? new Date() : null,
    });
    const table = (['off', 'company', 'shared'] as const).map((auto) =>
      (['private', 'shared', 'company'] as const).map((v) => mayBeSent(at(v), auto)),
    );
    expect(table).toEqual([
      [false, false, false],
      [false, false, true],
      [false, true, true],
    ]);
    expect(mayBeSent(at('private', true), 'off')).toBe(true);
    expect(mayBeSent({ ...at('company', true), deletedAt: new Date() }, 'shared')).toBe(false);
  });

  it('names the action after the one label every enabled endpoint shares', () => {
    expect(connectedLabel([{ label: 'Alex', enabled: true }])).toBe('Alex');
    expect(
      connectedLabel([
        { label: 'Alex', enabled: true },
        { label: null, enabled: true },
        { label: 'CRM', enabled: false },
      ]),
    ).toBe('Alex');
    expect(
      connectedLabel([
        { label: 'Alex', enabled: true },
        { label: 'CRM', enabled: true },
      ]),
    ).toBeNull();
    expect(connectedLabel([{ label: null, enabled: true }])).toBeNull();
  });

  it('takes links only from a bare https origin', () => {
    expect(linkOrigin('https://meetings.example.com')).toBe('https://meetings.example.com');
    expect(linkOrigin('https://meetings.example.com/x')).toBeNull();
    expect(linkOrigin('http://localhost:8788')).toBeNull();
    expect(linkOrigin('http://localhost:8788', true)).toBe('http://localhost:8788');
    expect(linkOrigin(undefined)).toBeNull();
  });
});

describe('the payload', () => {
  it('has exactly the documented shape, and no content', () => {
    const payload = buildPayload({
      event: 'recap.saved',
      now: new Date('2026-10-23T10:00:00Z'),
      productName: 'Primux Møder',
      meeting: {
        id: 'm1',
        title: 'Produktionsmøde',
        started_at: '2026-10-22T09:00:00.000Z',
        duration_s: 80,
        visibility: 'company',
        owner: { name: 'Mette Lund', email: 'mette@example.com' },
      },
      links: { transcript: 'https://x/t', recap_markdown: 'https://x/m', recap_docx: null },
      expiresAt: new Date('2026-10-23T11:00:00Z'),
    });
    expect(payload).toEqual({
      event: 'recap.saved',
      sent_at: '2026-10-23T10:00:00.000Z',
      install: { product_name: 'Primux Møder' },
      meeting: {
        id: 'm1',
        title: 'Produktionsmøde',
        started_at: '2026-10-22T09:00:00.000Z',
        duration_s: 80,
        visibility: 'company',
        owner: { name: 'Mette Lund', email: 'mette@example.com' },
      },
      links: { transcript: 'https://x/t', recap_markdown: 'https://x/m', recap_docx: null },
      expires_at: '2026-10-23T11:00:00.000Z',
    });
    const test = buildPayload({
      event: 'webhook.test',
      now: new Date('2026-10-23T10:00:00Z'),
      productName: 'P',
      meeting: null,
    });
    expect(test).toEqual({
      event: 'webhook.test',
      sent_at: '2026-10-23T10:00:00.000Z',
      install: { product_name: 'P' },
      meeting: null,
      links: null,
      expires_at: null,
    });
  });
});

describe('deliveries', () => {
  let db: Db;
  let raw: DatabaseSync;
  let sent: { job: Job; delaySeconds?: number }[];
  let posts: { url: string; init: RequestInit }[];
  let answer: () => Promise<Response>;
  let clock: Date;
  let endpointId: string;
  const secret = 'whsec_unit-test-secret-0123456789';

  const queue = {
    async send(job: Job, options?: { delaySeconds?: number }) {
      sent.push({ job, delaySeconds: options?.delaySeconds });
    },
    async sendBatch() {},
  };
  const publicResolver: HostResolver = {
    resolve: async () => [{ address: '93.184.216.34', ttl: 300 }],
  };
  const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
    db,
    installId: INSTALL,
    queue,
    resolver: publicResolver,
    settingsKey: KEY,
    publicUrl: 'https://meetings.example.com',
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return answer();
    }) as unknown as typeof fetch,
    now: () => clock,
    log: { log: () => {}, error: () => {} },
    ...over,
  });
  const q = () => ({ db, installId: INSTALL, queue, log: { log: () => {}, error: () => {} } });
  const deliveries = () =>
    raw
      .prepare(
        `select id, event, status, attempts, last_status_code, last_error, next_attempt_at
         from webhook_deliveries order by created_at, id`,
      )
      .all() as {
      id: string;
      event: string;
      status: string;
      attempts: number;
      last_status_code: number | null;
      last_error: string | null;
      next_attempt_at: number;
    }[];
  /** Runs the newest queued message, as the consumer would when it comes due. */
  const runLast = async (over: Partial<WebhookDeps> = {}) => {
    const message = sent.at(-1)!.job;
    if (message.type !== 'webhook') throw new Error('not a webhook job');
    await runWebhook(deps(over), message);
  };

  beforeEach(async () => {
    ({ db, sqlite: raw } = testDb());
    sent = [];
    posts = [];
    answer = async () => new Response('ok', { status: 200 });
    // The store dates a new delivery by the real clock; the job runs on this one from there.
    clock = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
    raw.exec(seedSql(INSTALL));
    raw.exec(`update settings set webhook_auto_send = 'company', product_name = 'Primux Møder';
      INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES
        ('owner', '${INSTALL}', 'sub', 'owner@example.com', 'Mette Lund');
      INSERT INTO meetings (id, install_id, owner_id, title, started_at, visibility) VALUES
        ('m-company', '${INSTALL}', 'owner', 'Produktionsmøde', 0, 'company'),
        ('m-private', '${INSTALL}', 'owner', 'Lønsamtale', 0, 'private');`);
    const created = await createEndpoint(db, INSTALL, {
      label: 'Alex',
      url: 'https://alex.example.com/hooks/mtxt',
      events: ['meeting.transcribed', 'recap.drafted', 'recap.saved', 'meeting.deleted'],
      sealedSecret: await seal(secret, 'webhook_endpoints.secret', KEY),
    });
    if (!created.ok) throw new Error('no endpoint');
    endpointId = created.id;
  });

  it('sends a company meeting automatically, signed, with links and no content', async () => {
    expect(
      await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' }),
    ).toBe(1);
    expect(sent).toEqual([
      { job: expect.objectContaining({ type: 'webhook', attempt: 1 }), delaySeconds: undefined },
    ]);
    await runLast();
    expect(posts).toHaveLength(1);
    const { url, init } = posts[0]!;
    expect(url).toBe('https://alex.example.com/hooks/mtxt');
    expect(init.redirect).toBe('manual');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Mtxt-Event']).toBe('meeting.transcribed');
    expect(headers['X-Mtxt-Delivery']).toBe(deliveries()[0]!.id);
    const body = String(init.body);
    expect(
      await verifySignature(headers['X-Mtxt-Signature']!, secret, body, clock.getTime() / 1000),
    ).toBe(true);
    const payload = JSON.parse(body);
    expect(Object.keys(payload).sort()).toEqual(
      ['event', 'expires_at', 'install', 'links', 'meeting', 'sent_at'].sort(),
    );
    expect(payload.meeting).toEqual({
      id: 'm-company',
      title: 'Produktionsmøde',
      started_at: '1970-01-01T00:00:00.000Z',
      duration_s: null,
      visibility: 'company',
      owner: { name: 'Mette Lund', email: 'owner@example.com' },
    });
    // Nothing to fetch yet: no transcript, no recap.
    expect(payload.links).toEqual({ transcript: null, recap_markdown: null, recap_docx: null });
    expect(deliveries()[0]).toMatchObject({
      status: 'delivered',
      attempts: 1,
      last_status_code: 200,
    });
    const audit = raw
      .prepare(`select user_id, meeting_id, action, details from audit_events`)
      .all() as { user_id: string; action: string; details: string }[];
    expect(audit).toEqual([
      {
        user_id: 'owner',
        meeting_id: 'm-company',
        action: 'webhook_sent',
        details: JSON.stringify({ endpoint: 'Alex', event: 'meeting.transcribed' }),
      },
    ]);
  });

  it('signs links for what there is to fetch', async () => {
    raw.exec(`INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s,
        sha256, size_bytes, storage_path, status, is_primary)
      VALUES ('r1', '${INSTALL}', 'm-company', 'owner', 'upload', 80, 'h', 1, 'p', 'transcribed', 1);
      INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status)
      VALUES ('t1', '${INSTALL}', 'r1', 'assemblyai', 'm', 'da', '{}', 'done');`);
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast();
    const payload = JSON.parse(String(posts[0]!.init.body));
    expect(payload.meeting.duration_s).toBe(80);
    expect(payload.links.transcript).toMatch(
      /^https:\/\/meetings\.example\.com\/api\/v1\/export\/v1\.m-company\.transcript\./,
    );
    expect(payload.links.recap_markdown).toBeNull();
    expect(payload.expires_at).toBe(new Date(clock.getTime() + 3600_000).toISOString());
    const token = payload.links.transcript.split('/export/')[1];
    expect(await readGrant(KEY, token, clock)).toMatchObject({
      ok: true,
      grant: { meetingId: 'm-company', format: 'transcript', endpointId },
    });
  });

  it('never queues a private meeting until the owner consents', async () => {
    expect(
      await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-private' }),
    ).toBe(0);
    raw.exec(`update meetings set webhook_consent_at = 1 where id = 'm-private'`);
    raw.exec(`INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s,
        sha256, size_bytes, storage_path, status, is_primary)
      VALUES ('r2', '${INSTALL}', 'm-private', 'owner', 'upload', 80, 'h', 1, 'p', 'transcribed', 1);
      INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status)
      VALUES ('t2', '${INSTALL}', 'r2', 'assemblyai', 'm', 'da', '{}', 'done');`);
    expect(await queueCurrentState(q(), 'm-private')).toEqual({
      queued: 1,
      transcript: true,
      recap: false,
    });
    // A second press sends the same transcript nothing new.
    expect((await queueCurrentState(q(), 'm-private')).queued).toBe(0);
  });

  it('retries after a 500 on the schedule, and parks after the sixth failure', async () => {
    answer = async () => new Response('down', { status: 500 });
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    const waits: (number | undefined)[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      await runLast();
      const row = deliveries()[0]!;
      expect(row.attempts).toBe(attempt);
      expect(row.last_status_code).toBe(500);
      expect(row.last_error).toBe('http_status');
      if (attempt < 6) {
        expect(row.status).toBe('pending');
        waits.push(sent.at(-1)!.delaySeconds);
        clock = new Date(row.next_attempt_at);
      }
    }
    // The 24-hour wait is two hops of the queue's 12-hour limit.
    expect(waits).toEqual([60, 600, 3600, 21_600, 43_200]);
    expect(deliveries()[0]!.status).toBe('parked');
    expect(posts).toHaveLength(6);
    expect(sent).toHaveLength(6);
  });

  it('reaches a wait over 12 hours in two hops', async () => {
    answer = async () => new Response('down', { status: 503 });
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    for (let i = 0; i < 5; i++) {
      await runLast();
      clock = new Date(deliveries()[0]!.next_attempt_at);
    }
    // After attempt 5 the next is due in 24 hours; the message came after 12.
    expect(deliveries()[0]!.attempts).toBe(5);
    clock = new Date(clock.getTime() - 12 * 3600 * 1000);
    await runLast();
    expect(posts).toHaveLength(5);
    expect(sent.at(-1)).toEqual({
      job: expect.objectContaining({ attempt: 6 }),
      delaySeconds: 43_200,
    });
  });

  it('Retry now sends a parked delivery once more, and a stale message does nothing', async () => {
    answer = async () => new Response('down', { status: 500 });
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast();
    const first = sent[0]!.job;
    const id = deliveries()[0]!.id;
    expect(await retryNow(q(), id, clock)).toBe(true);
    answer = async () => new Response(null, { status: 204 });
    await runLast();
    expect(deliveries()[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    // The scheduled message for attempt 2 arrives later and finds nothing to do.
    const scheduled = sent[1]!.job;
    clock = new Date(clock.getTime() + 60_000);
    if (scheduled.type === 'webhook') await runWebhook(deps(), scheduled);
    if (first.type === 'webhook') await runWebhook(deps(), first);
    expect(posts).toHaveLength(2);
    expect(await retryNow(q(), id, clock)).toBe(false);
  });

  it('cancels a delivery whose meeting turned private before its turn', async () => {
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    raw.exec(`update meetings set visibility = 'private' where id = 'm-company'`);
    await runLast();
    expect(posts).toHaveLength(0);
    expect(deliveries()[0]).toMatchObject({ status: 'cancelled', last_error: 'not_eligible' });
  });

  it('refuses a host that resolves to a private address, and counts it as a failure', async () => {
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast({ resolver: { resolve: async () => [{ address: '10.0.0.8', ttl: 300 }] } });
    expect(posts).toHaveLength(0);
    expect(deliveries()[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'private_address',
    });
  });

  it('resolves the host again before every attempt, and refuses it once it turns private', async () => {
    answer = async () => new Response('down', { status: 500 });
    let calls = 0;
    let address = '93.184.216.34';
    const resolver: HostResolver = {
      resolve: async () => {
        calls++;
        return [{ address, ttl: 300 }];
      },
    };
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    for (let i = 0; i < 3; i++) {
      await runLast({ resolver });
      clock = new Date(deliveries()[0]!.next_attempt_at);
    }
    expect(calls).toBe(3);
    expect(posts).toHaveLength(3);
    address = '10.0.0.8';
    await runLast({ resolver });
    expect(calls).toBe(4);
    expect(posts).toHaveLength(3);
    expect(deliveries()[0]).toMatchObject({ attempts: 4, last_error: 'private_address' });
  });

  it('records a timeout and a redirect, and never follows one', async () => {
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    answer = async () => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    };
    await runLast();
    expect(deliveries()[0]).toMatchObject({ last_error: 'timeout', last_status_code: null });
    clock = new Date(deliveries()[0]!.next_attempt_at);
    answer = async () =>
      new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } });
    await runLast();
    expect(deliveries()[0]).toMatchObject({ last_error: 'redirect', last_status_code: 302 });
    expect(posts).toHaveLength(2);
  });

  it('debounces recap.saved: each save moves the unsent delivery to a minute after itself', async () => {
    const save = (version: string) =>
      queueMeetingEvent(q(), {
        event: 'recap.saved',
        meetingId: 'm-company',
        dedupeKey: `saved:${version}`,
        delayS: 60,
      });
    expect(await save('v2')).toBe(1);
    const first = deliveries()[0]!.next_attempt_at;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.delaySeconds).toBe(60);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A later save: no new delivery, no new message, a later due time and the latest key.
    expect(await save('v3')).toBe(0);
    expect(sent).toHaveLength(1);
    const row = raw
      .prepare(`select next_attempt_at as due, dedupe_key as key from webhook_deliveries`)
      .get() as { due: number; key: string };
    expect(row.due).toBeGreaterThan(first);
    expect(row.key).toBe('saved:v3');
    // As if the second save came 59 s after the first.
    row.due = first + 59_000;
    raw.exec(`update webhook_deliveries set next_attempt_at = ${row.due}`);
    // The first save's message comes at its minute, finds the delivery not due, and sends itself on.
    clock = new Date(first);
    await runLast();
    expect(posts).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.job).toMatchObject({ attempt: 1 });
    clock = new Date(row.due);
    await runLast();
    expect(posts).toHaveLength(1);
    expect(deliveries()[0]).toMatchObject({ status: 'delivered', attempts: 1 });
  });

  it('joins an unsent event to the same endpoint, and sends a transcript once', async () => {
    const event = { event: 'meeting.shared' as const, meetingId: 'm-company', delayS: 60 };
    raw.exec(`update webhook_endpoints set events = json_insert(events, '$[#]', 'meeting.shared')`);
    expect(await queueMeetingEvent(q(), event)).toBe(1);
    expect(await queueMeetingEvent(q(), event)).toBe(0);
    expect(sent[0]!.delaySeconds).toBe(60);
    const once = {
      event: 'meeting.transcribed' as const,
      meetingId: 'm-company',
      dedupeKey: 'transcribed:t1',
    };
    expect(await queueMeetingEvent(q(), once)).toBe(1);
    await runLast();
    expect(await queueMeetingEvent(q(), once)).toBe(0);
    expect(deliveries().map((row) => row.event)).toEqual(['meeting.shared', 'meeting.transcribed']);
  });

  it('tries a failed queueing again, so a busy database does not lose the event', async () => {
    let failures = 2;
    const flaky = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'select' && failures > 0) {
          failures--;
          throw new Error('D1_ERROR: database is locked: SQLITE_BUSY');
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const queued = await queueMeetingEventQuietly(
      { ...q(), db: flaky },
      { event: 'meeting.transcribed', meetingId: 'm-company' },
      [1, 1],
    );
    expect(queued).toBe(1);
    expect(deliveries()).toHaveLength(1);
  });

  it('skips an endpoint that is disabled or does not take the event', async () => {
    raw.exec(`update webhook_endpoints set enabled = 0`);
    expect(
      await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' }),
    ).toBe(0);
    raw.exec(`update webhook_endpoints set enabled = 1`);
    expect(await queueMeetingEvent(q(), { event: 'meeting.shared', meetingId: 'm-company' })).toBe(
      0,
    );
  });

  it('tells an endpoint that took the meeting of its delete, with the id and the time only', async () => {
    // Nobody took an event of it yet: nobody hears of the delete.
    expect(await planDeleted(db, INSTALL, 'm-company')).toBeNull();
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast();
    const plan = await planDeleted(db, INSTALL, 'm-company');
    expect(plan?.endpointIds).toEqual([endpointId]);
    raw.exec(`delete from meetings where id = 'm-company'`);
    expect(await queueDeleted(q(), plan!, new Date('2026-10-23T12:00:00Z'))).toBe(1);
    await runLast();
    const body = String(posts[1]!.init.body);
    expect(JSON.parse(body)).toEqual({
      event: 'meeting.deleted',
      sent_at: clock.toISOString(),
      install: { product_name: 'Primux Møder' },
      meeting: { id: 'm-company', deleted_at: '2026-10-23T12:00:00.000Z' },
      links: null,
      expires_at: null,
    });
    expect(body).not.toContain('Produktionsmøde');
    expect(body).not.toContain('Mette Lund');
    // The audit row names the owner from the snapshot, detached from the meeting that is gone.
    expect(
      raw
        .prepare(
          `select user_id, meeting_id, details from audit_events where details like '%deleted%'`,
        )
        .all(),
    ).toEqual([
      {
        user_id: 'owner',
        meeting_id: null,
        details: JSON.stringify({ endpoint: 'Alex', event: 'meeting.deleted' }),
      },
    ]);
  });

  it('send, make private, rename, delete: the endpoint hears nothing of the private title', async () => {
    const { changeVisibility } = await import('../lib/meetings/sharing');
    raw.exec(`update meetings set webhook_consent_at = 1 where id = 'm-company'`);
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast();
    expect(deliveries()[0]!.status).toBe('delivered');
    const meeting = raw.prepare(`select * from meetings where id = 'm-company'`).get() as {
      owner_id: string;
    };
    await changeVisibility(
      db,
      INSTALL,
      {
        id: 'm-company',
        ownerId: meeting.owner_id,
        title: 'Produktionsmøde',
        visibility: 'company',
      },
      'private',
    );
    // Private took the consent back.
    expect(
      raw.prepare(`select webhook_consent_at as c from meetings where id = 'm-company'`).get(),
    ).toEqual({ c: null });
    raw.exec(`update meetings set title = 'Fyringsrunde, fortroligt' where id = 'm-company'`);
    expect(await planDeleted(db, INSTALL, 'm-company')).toBeNull();
    expect(posts.map((p) => String(p.init.body)).join('\n')).not.toContain('Fyringsrunde');
  });

  it('writes delivered and its audit row together: a failed audit insert leaves the delivery to retry', async () => {
    raw.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    const message = sent.at(-1)!.job;
    await expect(runLast()).rejects.toThrow();
    // Not delivered, and the claim is back: the queue's redelivery takes it at once.
    expect(deliveries()[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(raw.prepare(`select count(*) as n from audit_events`).get()).toEqual({ n: 0 });
    raw.exec(`DROP TRIGGER fail_audit`);
    if (message.type === 'webhook') await runWebhook(deps(), message);
    expect(deliveries()[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(
      raw.prepare(`select count(*) as n from audit_events where action = 'webhook_sent'`).get(),
    ).toEqual({ n: 1 });
    // At least once: the receiver saw the delivery twice, with the same id.
    expect(posts).toHaveLength(2);
    const ids = posts.map((p) => (p.init.headers as Record<string, string>)['X-Mtxt-Delivery']);
    expect(new Set(ids).size).toBe(1);
  });

  it('sends a test event to one endpoint with no meeting', async () => {
    expect(await queueTestEvent(q(), endpointId)).toBe(1);
    await runLast();
    const payload = JSON.parse(String(posts[0]!.init.body));
    expect(payload).toMatchObject({ event: 'webhook.test', meeting: null, links: null });
    expect(raw.prepare(`select count(*) as n from audit_events`).get()).toEqual({ n: 0 });
  });

  it('holds at most five endpoints', async () => {
    const add = () =>
      createEndpoint(db, INSTALL, {
        label: null,
        url: 'https://crm.example.com/',
        events: ['recap.saved'],
        sealedSecret: 'x',
      });
    for (let i = 0; i < 4; i++) expect((await add()).ok).toBe(true);
    expect(await add()).toEqual({ ok: false, reason: 'too_many' });
  });

  it('the nightly sweep prunes old finished deliveries and sends a lost one again', async () => {
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await queueTestEvent(q(), endpointId);
    const [lost, old] = deliveries();
    raw.exec(`update webhook_deliveries set next_attempt_at = 0 where id = '${lost!.id}';
      update webhook_deliveries set status = 'delivered', created_at = 0 where id = '${old!.id}'`);
    sent = [];
    expect(await sweepDeliveries(q(), clock)).toEqual({ pruned: 1, requeued: 1 });
    expect(sent).toEqual([
      {
        job: expect.objectContaining({ delivery_id: lost!.id, attempt: 1 }),
        delaySeconds: undefined,
      },
    ]);
  });

  it('logs no secret', async () => {
    const lines: string[] = [];
    const log = {
      log: (...a: unknown[]) => lines.push(a.join(' ')),
      error: (...a: unknown[]) => lines.push(a.join(' ')),
    };
    answer = async () => {
      throw new Error(`connect failed with ${secret}`);
    };
    await queueMeetingEvent(q(), { event: 'meeting.transcribed', meetingId: 'm-company' });
    await runLast({ log });
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('the export boundary', () => {
  it('opens the login gate for the one export shape only', async () => {
    const { isPublicPath } = await import('../lib/auth/session-config');
    expect(isPublicPath('/api/v1/export/v1.abc')).toBe(true);
    expect(isPublicPath('/api/v1/export/v1.abc/extra')).toBe(false);
    expect(isPublicPath('/api/v1/export/')).toBe(false);
    expect(isPublicPath('/api/v1/exports/v1.abc')).toBe(false);
  });

  it('refuses at the Worker entry another path, another method, and any body, unread', async () => {
    const { exportGuard } = await import('../lib/chunk-guard');
    const at = (path: string, init?: RequestInit) =>
      exportGuard(new Request(`https://meetings.example.com${path}`, init));
    expect(at('/api/v1/export/v1.abc')).toBeNull();
    expect(at('/api/v1/export/v1.abc', { method: 'HEAD' })).toBeNull();
    expect(at('/api/v1/meetings/m1/export?format=md')).toBeNull();
    expect(at('/api/v1/export/v1.abc/extra')?.status).toBe(404);
    expect(at('/api/v1/export')?.status).toBe(404);
    let read = false;
    const body = new ReadableStream({
      pull() {
        read = true;
      },
    });
    const post = at('/api/v1/export/v1.abc', {
      method: 'POST',
      body,
      headers: { 'content-length': String(1024 * 1024) },
      duplex: 'half',
    } as RequestInit);
    expect(post?.status).toBe(405);
    expect(post?.headers.get('allow')).toBe('GET, HEAD');
    expect(read).toBe(false);
    const withBody = new Request('https://meetings.example.com/api/v1/export/v1.abc', {
      headers: { 'content-length': '12' },
    });
    expect(exportGuard(withBody)?.status).toBe(400);
  });
});

describe('the export route', () => {
  let db: Db;
  let raw: DatabaseSync;
  const store = new Map<string, string>();

  beforeEach(async () => {
    ({ db, sqlite: raw } = testDb());
    raw.exec(seedSql(INSTALL));
    raw.exec(`update settings set webhook_auto_send = 'company';
      INSERT INTO users (id, install_id, oidc_subject, email, name) VALUES
        ('owner', '${INSTALL}', 'sub', 'owner@example.com', 'Mette Lund');
      INSERT INTO meetings (id, install_id, owner_id, title, started_at, visibility) VALUES
        ('m1', '${INSTALL}', 'owner', 'Produktionsmøde', 0, 'company');
      INSERT INTO recordings (id, install_id, meeting_id, uploaded_by, source, duration_s,
        sha256, size_bytes, storage_path, status, is_primary)
      VALUES ('r1', '${INSTALL}', 'm1', 'owner', 'upload', 80, 'h', 1, 'p', 'transcribed', 1);
      INSERT INTO transcripts (id, install_id, recording_id, provider, model, language, raw_json, status)
      VALUES ('t1', '${INSTALL}', 'r1', 'assemblyai', 'm', 'da', '{}', 'done');
      INSERT INTO speakers (id, install_id, meeting_id, label, speaker_index) VALUES
        ('s1', '${INSTALL}', 'm1', 'Speaker 1', 0);
      INSERT INTO segments (id, install_id, transcript_id, speaker_id, start_ms, end_ms, text) VALUES
        ('g1', '${INSTALL}', 't1', 's1', 0, 1500, 'Linje 2 kører igen.');
      INSERT INTO webhook_endpoints (id, install_id, label, url, secret, events, enabled)
      VALUES ('e1', '${INSTALL}', 'Alex', 'https://alex.example.com/', 'x', '["meeting.transcribed"]', 1);`);
    vi.doMock('@/lib/install', () => ({
      getEnv: async () => ({ SETTINGS_KEY: KEY }),
      getAdapters: async () => ({
        db,
        installId: INSTALL,
        storage: { get: async (key: string) => (store.has(key) ? { body: store.get(key) } : null) },
      }),
    }));
  });

  const fetchLink = async (token: string) => {
    const { GET } = await import('../app/api/v1/export/[token]/route');
    return GET(new Request(`https://meetings.example.com/api/v1/export/${token}`), {
      params: Promise.resolve({ token }),
    });
  };
  const token = (over: Partial<Parameters<typeof createGrant>[1]> = {}) =>
    createGrant(KEY, {
      meetingId: 'm1',
      format: 'transcript',
      endpointId: 'e1',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      ...over,
    });

  it('serves the transcript while the meeting may be sent, and 404 once it may not', async () => {
    const response = await fetchLink(await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      meeting_id: 'm1',
      language: 'da',
      speakers: [{ id: 's1', name: 'Speaker 1' }],
      segments: [{ start_ms: 0, end_ms: 1500, speaker_id: 's1', text: 'Linje 2 kører igen.' }],
    });
    expect(raw.prepare(`select user_id, action, details from audit_events`).all()).toEqual([
      {
        user_id: 'owner',
        action: 'exported',
        details: JSON.stringify({ format: 'transcript', via: 'webhook', endpoint: 'Alex' }),
      },
    ]);
    raw.exec(`update meetings set visibility = 'private' where id = 'm1'`);
    expect((await fetchLink(await token())).status).toBe(404);
  });

  it('answers 404, not 500, for a token that is only a percent sign', async () => {
    // Next.js hands the route `%` for `/export/%25`.
    expect((await fetchLink('%')).status).toBe(404);
  });

  it('answers 410 for an expired link, 404 for a forged one, a disabled endpoint or no recap', async () => {
    expect((await fetchLink(await token({ expiresAt: 1 }))).status).toBe(410);
    expect((await fetchLink((await token()).slice(0, -2) + 'AA')).status).toBe(404);
    expect((await fetchLink(await token({ format: 'md' }))).status).toBe(404);
    raw.exec(`update webhook_endpoints set enabled = 0`);
    expect((await fetchLink(await token())).status).toBe(404);
  });
});
