#!/usr/bin/env node
// Creates or updates one mtxt install in the owning company's Cloudflare account.
//
//   node deploy/install.mjs --config deploy/installs/<name>.json            plan, then apply
//   node deploy/install.mjs --config deploy/installs/<name>.json --dry-run  plan only
//   node deploy/install.mjs --config deploy/installs/<name>.json --status   what is deployed
//   node deploy/install.mjs --config deploy/installs/<name>.json --config-only
//                         write apps/web/wrangler.<installId>.jsonc and stop
//   eval "$(node deploy/install.mjs --config deploy/installs/<name>.json --print-env)"
//                         export the account, the generated config and the names (runbook)
//
// Flags: --force-deploy builds and deploys even when the deployed version matches,
// --replace-secrets puts every secret in the secrets file again (rotation, a changed
// OIDC value), --skip-build deploys the build already in apps/web/.open-next.
//
// Idempotent: every resource is found by name before anything is created, the
// settings row is written only when it does not exist, a secret is put only when
// the Worker lacks it, and a Worker whose deployed tag matches this commit and
// config is left alone. It never deletes anything and never prints a secret.
// See deploy/README.md.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { seedSql } from '../packages/adapters/src/db/seed.ts';
import { seal } from '../packages/adapters/src/secrets.ts';
import {
  fail,
  loadInstall,
  readGeneratedConfig as readGeneratedConfigFor,
  parseJsonc,
  readEnvFile,
  root,
  runMain,
  Stop,
  web,
  wranglerBin,
  writePrivateFile,
} from './lib.mjs';

const API = 'https://api.cloudflare.com/client/v4';

const { values: flags } = parseArgs({
  options: {
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    'force-deploy': { type: 'boolean', default: false },
    'replace-secrets': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    'config-only': { type: 'boolean', default: false },
    'print-env': { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------- output

const say = (line = '') => console.log(line);
const step = (title) => say(`\n== ${title}`);
const row = (what, outcome) => say(`  ${what.padEnd(34)} ${outcome}`);

// ---------------------------------------------------------------- config

// Nothing has run yet, so a bad config stops at once.
let install;
try {
  install = loadInstall(flags.config);
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  console.error(`\nStopped: ${error.message}`);
  process.exit(1);
}
const { accountId, hostname, installId, names, settings, secretsFile, generatedConfig } = install;
const publicUrl = `https://${hostname}`;

// Every child process runs against this account and nothing else.
const childEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

// ---------------------------------------------------------------- processes

/** Runs a command. `show` streams its output; otherwise it is captured and returned. */
function run(cmd, args, { show = false, cwd = web, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: show ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFail) {
    if (!show) process.stderr.write((result.stderr ?? '') + (result.stdout ?? ''));
    fail(`${cmd === wranglerBin ? 'wrangler' : cmd} ${args.slice(0, 3).join(' ')} failed.`);
  }
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
}
const wrangler = (args, options) => run(wranglerBin, args, options);

/**
 * The Cloudflare CLI (`cf`), when it is installed and logged in. Wrangler's OAuth login
 * has no AI Gateway scope; `cf`'s OAuth login has, so the gateway steps use it when the
 * API refuses wrangler's token. `ok` is false when `cf` is missing or the call fails.
 */
function cf(args) {
  const result = spawnSync('cf', args, {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: !result.error && result.status === 0,
    out: result.stdout ?? '',
    err: result.stderr ?? '',
  };
}

/** The gateway body: no logs (prompts carry meeting content) and no cache. */
const GATEWAY_BODY = (id) => ({
  id,
  collect_logs: false,
  cache_ttl: 0,
  cache_invalidate_on_update: false,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: 'fixed',
});
const withConfig = (args) => [...args, '--config', generatedConfig];

// ---------------------------------------------------------------- Cloudflare API

let token;
function apiToken() {
  if (token) return token;
  const { out } = wrangler(['auth', 'token', '--json']);
  token = JSON.parse(out.slice(out.indexOf('{'))).token;
  if (!token) fail('wrangler has no login. Run `npx wrangler login` and start again.');
  return token;
}

/** One API call. Returns { ok, status, result, errors }; never throws on a 4xx. */
async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return {
    ok: response.ok && json.success !== false,
    status: response.status,
    result: json.result,
    info: json.result_info ?? {},
    errors: (json.errors ?? []).map((e) => `${e.code} ${e.message}`),
  };
}
const account = (path) => `/accounts/${accountId}${path}`;

/**
 * Every item of a list endpoint, through all its pages: by cursor (R2), by
 * total_count or by total_pages. Existence is never decided on the first page alone.
 */
async function apiAll(path, { headers, items = (result) => result } = {}) {
  const all = [];
  let page = 1;
  let cursor;
  for (let guard = 0; guard < 1000; guard++) {
    const sep = path.includes('?') ? '&' : '?';
    const at = cursor ? `cursor=${encodeURIComponent(cursor)}` : `page=${page}`;
    const res = await api(`${path}${sep}${at}`, { headers });
    if (!res.ok) return res;
    const batch = items(res.result) ?? [];
    all.push(...batch);
    const { cursor: next, total_count: total, total_pages: pages } = res.info;
    if (next && next !== cursor) cursor = next;
    else if (!cursor && total !== undefined && batch.length && all.length < total) page++;
    else if (!cursor && total === undefined && pages && page < pages) page++;
    else return { ok: true, result: all };
  }
  fail(`${path} returned more than 1000 pages.`);
}

// ---------------------------------------------------------------- secrets file

/** Adds lines to the secrets file. The new file is 0600 before a secret byte is in it. */
function appendEnvFile(path, entries) {
  const head = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  const note =
    '# Generated by deploy/install.mjs. The Worker holds the same values; losing\n' +
    '# MTXT_SETTINGS_KEY makes the sealed settings unreadable (deploy/README.md).\n';
  writePrivateFile(
    path,
    `${head}${head && !head.endsWith('\n') ? '\n' : ''}${note}${lines.join('\n')}\n`,
  );
}

// The Worker secrets, by their Worker name, from MTXT_* in the shell or the secrets file.
const SECRET_NAMES = [
  'AUTH_SECRET',
  'SETTINGS_KEY',
  'OIDC_PROVIDER',
  'OIDC_TENANT_ID',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
];
function localSecrets() {
  const file = readEnvFile(secretsFile);
  const pick = (name) => (process.env[`MTXT_${name}`] ?? file[`MTXT_${name}`] ?? '').trim();
  const values = Object.fromEntries(SECRET_NAMES.map((n) => [n, pick(n)]).filter(([, v]) => v));
  if (!values.OIDC_PROVIDER && values.OIDC_CLIENT_ID && settings.identityProvider) {
    values.OIDC_PROVIDER = settings.identityProvider;
  }
  return { values, assemblyAiKey: pick('ASSEMBLYAI_KEY') };
}

// ---------------------------------------------------------------- inventory

async function inventory() {
  const found = {};

  const me = await api(account(''));
  if (!me.ok) fail(`this login cannot read account ${accountId}: ${me.errors.join('; ')}`);
  found.accountName = me.result.name;

  const zones = await apiAll(`/zones?account.id=${accountId}&per_page=50&status=active`);
  if (!zones.ok) fail(`cannot list zones: ${zones.errors.join('; ')}`);
  found.zone = zones.result
    .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];

  const dbs = await apiAll(account(`/d1/database?name=${names.database}&per_page=100`));
  if (!dbs.ok) fail(`cannot list D1 databases: ${dbs.errors.join('; ')}`);
  found.database = dbs.result.find((d) => d.name === names.database);

  const buckets = (r) => r.buckets;
  const euBuckets = await apiAll(account('/r2/buckets?per_page=1000'), {
    headers: { 'cf-r2-jurisdiction': 'eu' },
    items: buckets,
  });
  const plainBuckets = await apiAll(account('/r2/buckets?per_page=1000'), { items: buckets });
  if (!euBuckets.ok || !plainBuckets.ok) fail('cannot list R2 buckets.');
  found.bucket = euBuckets.result.find((b) => b.name === names.bucket);
  found.bucketOutsideEu = plainBuckets.result.find((b) => b.name === names.bucket);

  const queues = await apiAll(account('/queues?per_page=100'));
  if (!queues.ok) fail(`cannot list queues: ${queues.errors.join('; ')}`);
  found.queue = queues.result.find((q) => q.queue_name === names.queue);
  found.deadLetterQueue = queues.result.find((q) => q.queue_name === names.deadLetterQueue);

  if (names.gateway) {
    const gw = await api(account(`/ai-gateway/gateways/${names.gateway}`));
    found.gatewayVia = 'api';
    found.gateway = gw.ok
      ? 'exists'
      : gw.status === 404 || gw.errors.some((e) => e.startsWith('7002'))
        ? 'missing'
        : 'unreadable';
    if (found.gateway === 'unreadable') {
      // One gateway by its id: no list, so no page to miss it on.
      const got = cf(['ai-gateway', 'gateways', 'get', names.gateway]);
      if (got.ok) found.gateway = 'exists';
      else if (/\b7002\b|404 Not Found/.test(got.err + got.out)) found.gateway = 'missing';
      if (found.gateway !== 'unreadable') found.gatewayVia = 'cf';
    }
  }

  const scripts = await apiAll(account('/workers/scripts'));
  if (!scripts.ok) fail(`cannot list Workers: ${scripts.errors.join('; ')}`);
  found.worker = scripts.result.find((s) => s.id === names.worker);

  const domains = await api(account(`/workers/domains?hostname=${hostname}`));
  found.domain = domains.ok ? domains.result.find((d) => d.hostname === hostname) : undefined;

  found.secrets = [];
  if (found.worker) {
    const { out } = wrangler(['secret', 'list', '--name', names.worker, '--format', 'json']);
    found.secrets = JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name);
  }
  return found;
}

// ---------------------------------------------------------------- config generation

function installConfig(found, gatewayId) {
  const base = parseJsonc(readFileSync(join(web, 'wrangler.jsonc'), 'utf8'));
  const cfg = {
    ...base,
    name: names.worker,
    account_id: accountId,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    vars: {
      ...base.vars,
      INSTALL_ID: installId,
      PUBLIC_URL: publicUrl,
    },
    d1_databases: [
      {
        ...base.d1_databases[0],
        database_name: names.database,
        database_id: found.database?.uuid ?? '00000000-0000-0000-0000-000000000000',
      },
    ],
    r2_buckets: [{ ...base.r2_buckets[0], bucket_name: names.bucket, jurisdiction: 'eu' }],
    queues: {
      producers: base.queues.producers.map((p) => ({ ...p, queue: names.queue })),
      consumers: base.queues.consumers.map((c) => ({
        ...c,
        queue: names.queue,
        dead_letter_queue: names.deadLetterQueue,
      })),
    },
  };
  return (
    `// Generated by deploy/install.mjs for install "${installId}" on ${hostname}.\n` +
    `// Not in git (it holds this account's ids). Edit deploy/ or wrangler.jsonc, then run it again.\n` +
    JSON.stringify(cfg, null, 2) +
    '\n'
  );
}

// ---------------------------------------------------------------- D1 helpers

function d1Query(sql) {
  const { out } = wrangler(
    withConfig(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql]),
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? [];
}

function d1File(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'mtxt-deploy-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    wrangler(withConfig(['d1', 'execute', 'DB', '--remote', `--file=${file}`, '--yes']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pendingMigrations() {
  const { out } = wrangler(withConfig(['d1', 'migrations', 'list', 'DB', '--remote']));
  return [...out.matchAll(/\b(\d{4}_[A-Za-z0-9_]+\.sql)\b/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------- deploy tag

const git = (args) => run('git', args, { cwd: root, allowFail: true }).out.trim();

/**
 * Everything the build reads: apps/web (its own configs included), packages, and the
 * root files the workspace and TypeScript resolve through. Paths that are not in git
 * (an .npmrc nobody made) are left out.
 */
const BUILD_INPUTS = [
  'apps/web',
  'packages',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.base.json',
  '.npmrc',
  '.node-version',
];

/**
 * The deploy fingerprint: the git objects of the build inputs plus the generated
 * config. A commit that touches only docs or deploy/ keeps the tag, so a run after
 * it deploys nothing; an uncommitted change to any input always deploys.
 */
function desiredTag(configText) {
  const commit = git(['rev-parse', '--short=12', 'HEAD']) || 'nogit';
  const tracked = BUILD_INPUTS.filter((p) => git(['ls-files', '--', p]) !== '');
  const inputs = git(['rev-parse', ...tracked.map((p) => `HEAD:${p}`)]);
  const dirty = git(['status', '--porcelain', '--', ...BUILD_INPUTS]) !== '';
  const code = createHash('sha256').update(inputs).digest('hex').slice(0, 12);
  const cfg = createHash('sha256').update(configText).digest('hex').slice(0, 8);
  return { tag: `${code}-${cfg}`, dirty, commit };
}

/**
 * The tag of the code that is live: the newest deployment that was not only a
 * secret change (a secret put makes a version of its own, with the same code).
 * Its message is `mtxt-<tag>-at-<commit>`; a rollback or a dashboard deploy has none.
 */
function deployedTag() {
  const list = wrangler(['deployments', 'list', '--name', names.worker, '--json'], {
    allowFail: true,
  });
  if (!list.ok) return null;
  const deployments = JSON.parse(list.out.slice(list.out.indexOf('[')));
  const code = deployments
    .filter((d) => d.annotations?.['workers/triggered_by'] !== 'secret')
    .sort((a, b) => a.created_on.localeCompare(b.created_on))
    .at(-1);
  const message = code?.annotations?.['workers/message'] ?? '';
  return message.match(/^mtxt-([0-9a-f]{12}-[0-9a-f]{8})-at-/)?.[1] ?? null;
}

// ---------------------------------------------------------------- status

async function status() {
  const found = await inventory();
  step(`Install "${installId}" in ${found.accountName}`);
  row('Worker', found.worker ? names.worker : 'missing');
  row('Custom domain', found.domain ? `${hostname} -> ${found.domain.service}` : 'missing');
  row('Deployed tag', (found.worker && deployedTag()) || 'none');
  row('Secrets set', found.secrets.join(', ') || 'none');
  row(
    'Secrets missing',
    SECRET_NAMES.filter((n) => !found.secrets.includes(n)).join(', ') || 'none',
  );
  row(
    'D1',
    found.database
      ? `${names.database} (jurisdiction ${found.database.jurisdiction ?? 'none'})`
      : 'missing',
  );
  row('R2', found.bucket ? `${names.bucket} (jurisdiction eu)` : 'missing');
  for (const q of [found.queue, found.deadLetterQueue].filter(Boolean)) {
    const consumers = await api(account(`/queues/${q.queue_id}/consumers`));
    const bound = consumers.ok
      ? consumers.result.map((c) => c.script ?? c.service).join(', ')
      : '?';
    row(`Queue ${q.queue_name}`, `consumers: ${bound || 'none'}`);
  }
  if (found.worker) {
    const schedules = await api(account(`/workers/scripts/${names.worker}/schedules`));
    row(
      'Cron triggers',
      schedules.ok ? schedules.result.schedules.map((s) => s.cron).join(', ') : '?',
    );
    if (found.database) {
      // The migrations list reads the database id from the install's config.
      if (!existsSync(generatedConfig)) {
        writeFileSync(generatedConfig, installConfig(found, configuredGateway(found)));
      }
      readGeneratedConfigOrStop();
      const pending = pendingMigrations();
      row('D1 migrations pending', pending.join(', ') || 'none');
    }
  }
  row('AI Gateway', names.gateway ? `${names.gateway}: ${found.gateway}` : 'not used');
}

/** The gateway id the install uses: only one that is known to exist. */
const configuredGateway = (found) =>
  names.gateway && found.gateway === 'exists' ? names.gateway : null;

// ---------------------------------------------------------------- main

/** The generated config must be this install's; see lib.mjs readGeneratedConfig. */
function readGeneratedConfigOrStop() {
  return readGeneratedConfigFor(install);
}

/** Shell exports for the runbook's commands: no API call, nothing secret. */
function printEnv() {
  const q = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;
  const vars = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    MTXT_INSTALL_ID: installId,
    MTXT_CFG: generatedConfig,
    MTXT_WRANGLER: wranglerBin,
    MTXT_WORKER: names.worker,
    MTXT_DB: names.database,
    MTXT_BUCKET: names.bucket,
    MTXT_QUEUE: names.queue,
    MTXT_DLQ: names.deadLetterQueue,
    MTXT_GATEWAY: names.gateway ?? '',
  };
  for (const [k, v] of Object.entries(vars)) say(`export ${k}=${q(v)}`);
}

/** Writes the generated config from what exists, and stops. Creates nothing. */
async function configOnly() {
  const found = await inventory();
  if (!found.database)
    fail(`D1 ${names.database} does not exist. Run the install without --config-only.`);
  const text = installConfig(found, configuredGateway(found));
  writeFileSync(generatedConfig, text);
  readGeneratedConfigOrStop();
  row(generatedConfig.slice(root.length + 1), 'written');
}

async function main() {
  if (flags['print-env']) return printEnv();
  if (flags.status) return status();
  if (flags['config-only']) return configOnly();

  step(`Plan for install "${installId}" on ${hostname}`);
  const found = await inventory();
  row('Account', `${found.accountName}`);
  if (!found.zone) fail(`no active zone in this account holds ${hostname}.`);
  row('Zone', found.zone.name);
  if (found.bucketOutsideEu && !found.bucket) {
    fail(`an R2 bucket "${names.bucket}" exists outside the EU jurisdiction. Pick another name.`);
  }
  if (found.domain && found.domain.service !== names.worker) {
    fail(`${hostname} is already a custom domain of the Worker "${found.domain.service}".`);
  }

  const plan = [];
  const add = (what, action) => {
    plan.push({ what, action });
    row(what, action);
  };
  add(`D1 ${names.database}`, found.database ? 'reuse' : 'create (jurisdiction eu)');
  add(`R2 ${names.bucket}`, found.bucket ? 'reuse' : 'create (jurisdiction eu)');
  add(
    `Queue ${names.deadLetterQueue}`,
    found.deadLetterQueue ? 'reuse' : 'create (jurisdiction eu)',
  );
  add(`Queue ${names.queue}`, found.queue ? 'reuse' : 'create (jurisdiction eu)');
  if (names.gateway) {
    add(
      `AI Gateway ${names.gateway}`,
      {
        exists: 'reuse',
        missing: `create (logs off, no cache${found.gatewayVia === 'cf' ? ', with the cf CLI' : ''})`,
        unreadable: 'skip: neither this login nor a logged-in cf CLI can read AI Gateway',
      }[found.gateway],
    );
  }
  add(`Worker ${names.worker}`, found.worker ? 'update if the code or config changed' : 'create');
  add(`Custom domain ${hostname}`, found.domain ? 'reuse' : 'attach with the deploy');

  const { values: local, assemblyAiKey } = localSecrets();
  const toGenerate = ['AUTH_SECRET', 'SETTINGS_KEY'].filter(
    (n) => !local[n] && !found.secrets.includes(n),
  );
  for (const name of SECRET_NAMES) {
    const there = found.secrets.includes(name);
    const action = toGenerate.includes(name)
      ? 'generate and set'
      : local[name] && (!there || flags['replace-secrets'])
        ? there
          ? 'replace'
          : 'set'
        : there
          ? 'unchanged'
          : 'missing: not in the secrets file';
    add(`Secret ${name}`, action);
  }
  add(
    'Speech-to-text key',
    assemblyAiKey ? 'seal into the settings row if it has no provider' : 'none given',
  );
  say(`\n  Secrets file: ${secretsFile}${existsSync(secretsFile) ? '' : ' (not there yet)'}`);

  if (flags['dry-run']) {
    say('\nDry run: nothing was changed.');
    return;
  }

  // ---- resources
  step('Resources');
  if (!found.database) {
    wrangler(['d1', 'create', names.database, '--jurisdiction', 'eu']);
    row(`D1 ${names.database}`, 'created');
  } else
    row(`D1 ${names.database}`, `exists (jurisdiction ${found.database.jurisdiction ?? 'none'})`);
  if (!found.bucket) {
    wrangler(['r2', 'bucket', 'create', names.bucket, '--jurisdiction', 'eu']);
    row(`R2 ${names.bucket}`, 'created');
  } else row(`R2 ${names.bucket}`, 'exists');
  for (const [key, name] of [
    ['deadLetterQueue', names.deadLetterQueue],
    ['queue', names.queue],
  ]) {
    if (!found[key]) {
      wrangler(['queues', 'create', name, '--jurisdiction', 'eu']);
      row(`Queue ${name}`, 'created');
    } else row(`Queue ${name}`, 'exists');
  }
  let gatewayCreated = false;
  if (names.gateway && found.gateway === 'missing') {
    let problem = null;
    if (found.gatewayVia === 'cf') {
      const out = cf([
        'ai-gateway',
        'gateways',
        'create',
        '--body',
        JSON.stringify(GATEWAY_BODY(names.gateway)),
      ]);
      if (!out.ok) problem = 'the cf CLI refused the create';
    } else {
      const created = await api(account('/ai-gateway/gateways'), {
        method: 'POST',
        body: GATEWAY_BODY(names.gateway),
      });
      if (!created.ok) problem = created.errors.join('; ');
    }
    gatewayCreated = !problem;
    row(`AI Gateway ${names.gateway}`, problem ? `not created: ${problem}` : 'created');
  } else if (names.gateway) {
    row(
      `AI Gateway ${names.gateway}`,
      found.gateway === 'exists'
        ? 'exists'
        : 'skipped: no permission; create it in the dashboard (see deploy/README.md)',
    );
  }

  const now = await inventory();
  if (!now.database || !now.bucket || !now.queue || !now.deadLetterQueue) {
    fail('a resource is still missing after the create step.');
  }
  const gatewayId = configuredGateway(now);

  // ---- wrangler config
  step('Wrangler config');
  const configText = installConfig(now, gatewayId);
  const before = existsSync(generatedConfig) ? readFileSync(generatedConfig, 'utf8') : '';
  if (before !== configText) writeFileSync(generatedConfig, configText);
  readGeneratedConfigOrStop();
  row(generatedConfig.slice(root.length + 1), before === configText ? 'unchanged' : 'written');

  // ---- database
  step('Database');
  const pending = pendingMigrations();
  if (pending.length) {
    wrangler(withConfig(['d1', 'migrations', 'apply', 'DB', '--remote']), { show: false });
    row('Migrations', `applied ${pending.join(', ')}`);
  } else row('Migrations', 'none pending');

  const existing = d1Query(
    `SELECT product_name, stt_provider FROM settings WHERE install_id = '${installId}'`,
  );
  if (existing.length === 0) {
    d1File(
      seedSql(installId, {
        productName: settings.productName,
        companyName: settings.companyName,
        language: settings.language,
        interfaceLanguage: settings.interfaceLanguage,
        aiGatewayId: gatewayId,
      }),
    );
    row('Settings row', `written ("${settings.productName ?? 'Meetings'}")`);
  } else row('Settings row', `exists ("${existing[0].product_name}"); left alone`);
  // A gateway this run created goes into a row that has none. A later run leaves the
  // column alone, so an admin who clears it on the settings page keeps it cleared.
  if (existing.length > 0 && gatewayCreated && gatewayId) {
    d1File(
      `UPDATE settings SET ai_gateway_id = '${gatewayId}' ` +
        `WHERE install_id = '${installId}' AND ai_gateway_id IS NULL;\n`,
    );
    row('Settings ai_gateway_id', `${gatewayId}, if the row had none`);
  }

  // ---- secrets: what the Worker gets
  const generated = {};
  for (const name of toGenerate) {
    generated[name] = randomBytes(32).toString('base64');
  }
  if (Object.keys(generated).length) {
    appendEnvFile(
      secretsFile,
      Object.fromEntries(Object.entries(generated).map(([k, v]) => [`MTXT_${k}`, v])),
    );
  }
  const secrets = { ...local, ...generated };

  // The speech-to-text key is sealed here, under the same SETTINGS_KEY the Worker holds.
  const sttWanted = settings.sttProvider ?? (assemblyAiKey ? 'assemblyai' : null);
  const row0 = d1Query(`SELECT stt_provider FROM settings WHERE install_id = '${installId}'`)[0];
  if (row0?.stt_provider) {
    row('Speech-to-text', `${row0.stt_provider} already chosen; left alone`);
  } else if (sttWanted === 'assemblyai' && assemblyAiKey && secrets.SETTINGS_KEY) {
    const sealed = await seal(assemblyAiKey, 'settings.stt_api_key', secrets.SETTINGS_KEY);
    d1File(
      `UPDATE settings SET stt_provider = 'assemblyai', stt_api_key = '${sealed}', stt_region = NULL ` +
        `WHERE install_id = '${installId}' AND stt_provider IS NULL;\n`,
    );
    row('Speech-to-text', 'assemblyai, key sealed into the settings row');
  } else if (sttWanted === 'workers-ai-whisper') {
    d1File(
      `UPDATE settings SET stt_provider = 'workers-ai-whisper' WHERE install_id = '${installId}' AND stt_provider IS NULL;\n`,
    );
    row('Speech-to-text', 'workers-ai-whisper');
  } else if (sttWanted === 'assemblyai' && assemblyAiKey) {
    row('Speech-to-text', 'not set: SETTINGS_KEY is on the Worker but not in the secrets file');
  } else {
    row('Speech-to-text', 'not set: no key given; choose it on the settings page');
  }

  // ---- worker
  step('Worker');
  const { tag, dirty, commit } = desiredTag(configText);
  const current = now.worker ? deployedTag() : null;
  if (!flags['force-deploy'] && !dirty && current === tag) {
    row(names.worker, `unchanged (tag ${tag})`);
  } else {
    if (!flags['skip-build']) {
      say('  Building with OpenNext (a minute or two)...');
      run('pnpm', ['build:cf'], { show: false });
      row('Build', 'done');
    }
    // Also with --skip-build: .open-next may hold an e2e build with its fake providers.
    run('pnpm', ['check:no-fakes'], { show: false });
    row('Bundle', 'no fake providers');
    // A build from uncommitted files never matches a later run's tag.
    const deployTag = dirty ? `${tag.slice(0, 12)}-dirty000` : tag;
    run(
      join(web, 'node_modules/.bin/opennextjs-cloudflare'),
      // OpenNext runs wrangler through a shell: a path relative to apps/web and no spaces.
      [
        'deploy',
        '--config',
        `wrangler.${installId}.jsonc`,
        '--',
        '--tag',
        deployTag,
        '--message',
        `mtxt-${deployTag}-at-${commit}`,
      ],
      { show: false },
    );
    row(names.worker, `deployed (tag ${deployTag}, commit ${commit})`);
  }

  // ---- secrets, now that the Worker exists
  step('Secrets');
  const put = Object.fromEntries(
    Object.entries(secrets).filter(
      ([name]) => generated[name] || !now.secrets.includes(name) || flags['replace-secrets'],
    ),
  );
  if (Object.keys(put).length) {
    const dir = mkdtempSync(join(tmpdir(), 'mtxt-secrets-'));
    const file = join(dir, 'secrets.json');
    writeFileSync(file, JSON.stringify(put), { mode: 0o600 });
    try {
      wrangler(['secret', 'bulk', file, '--name', names.worker]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const name of SECRET_NAMES) {
    row(name, put[name] ? 'set' : now.secrets.includes(name) ? 'unchanged' : 'missing');
  }

  // ---- check
  step('Result');
  const after = await inventory();
  row('Custom domain', after.domain ? `${hostname} -> ${after.domain.service}` : 'missing');
  const missing = SECRET_NAMES.filter((n) => !after.secrets.includes(n));
  row('Secrets missing', missing.join(', ') || 'none');
  say(`\n  Open ${publicUrl}/login. Smoke test: node deploy/smoke.mjs ${hostname}`);
  if (missing.some((n) => n.startsWith('OIDC_'))) {
    say(
      `  The login page names the missing OIDC values. Add them to ${secretsFile}\n` +
        '  (MTXT_OIDC_PROVIDER, MTXT_OIDC_TENANT_ID, MTXT_OIDC_CLIENT_ID, MTXT_OIDC_CLIENT_SECRET)\n' +
        '  and run this again: only the secrets are put, the code is not deployed again.',
    );
  }
}

await runMain(main);
