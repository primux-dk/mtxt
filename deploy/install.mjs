#!/usr/bin/env node
// Creates or updates one mtxt install in the owning company's Cloudflare account.
//
//   node deploy/install.mjs --config deploy/installs/<name>.json            plan, then apply
//   node deploy/install.mjs --config deploy/installs/<name>.json --dry-run  plan only
//   node deploy/install.mjs --config deploy/installs/<name>.json --status   what is deployed
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { seedSql } from '../packages/adapters/src/db/seed.ts';
import { seal } from '../packages/adapters/src/secrets.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web');
const wranglerBin = join(web, 'node_modules/.bin/wrangler');
const API = 'https://api.cloudflare.com/client/v4';

const { values: flags } = parseArgs({
  options: {
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    'force-deploy': { type: 'boolean', default: false },
    'replace-secrets': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
  },
});
if (!flags.config) fail('Pass --config <install.json>. Copy deploy/install.example.json to start.');

// ---------------------------------------------------------------- output

const say = (line = '') => console.log(line);
const step = (title) => say(`\n== ${title}`);
const row = (what, outcome) => say(`  ${what.padEnd(34)} ${outcome}`);
function fail(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- config

const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(root, p));
const config = JSON.parse(readFileSync(expand(flags.config), 'utf8'));

const accountId = String(config.accountId ?? '').trim();
const hostname = String(config.hostname ?? '')
  .trim()
  .toLowerCase();
const installId = String(config.installId ?? '').trim();
if (!/^[0-9a-f]{32}$/.test(accountId)) fail('accountId must be the 32-character account id.');
if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
  fail(`hostname must be a bare host name, like meetings.example.com: "${hostname}"`);
}
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(installId)) {
  fail('installId must be 1-64 lowercase letters, digits, _ or -.');
}
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
  fail('CLOUDFLARE_ACCOUNT_ID in this shell names another account than the config. Unset it.');
}

const names = {
  worker: 'mtxt-web',
  database: 'mtxt-db',
  bucket: 'mtxt-audio',
  queue: 'mtxt-jobs',
  deadLetterQueue: 'mtxt-jobs-dlq',
  gateway: 'mtxt-gateway',
  ...config.names,
};
for (const [key, value] of Object.entries(names)) {
  if (value !== null && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) {
    fail(`names.${key} must be lowercase letters, digits and -: "${value}"`);
  }
}

const settings = config.settings ?? {};
if (settings.interfaceLanguage && !['en', 'da'].includes(settings.interfaceLanguage)) {
  fail('settings.interfaceLanguage is en or da.');
}
if (settings.identityProvider && !['entra', 'google'].includes(settings.identityProvider)) {
  fail('settings.identityProvider is entra or google.');
}
if (settings.sttProvider && !['assemblyai', 'workers-ai-whisper'].includes(settings.sttProvider)) {
  fail('settings.sttProvider is assemblyai or workers-ai-whisper in this version.');
}

const secretsFile = expand(config.secretsFile ?? `~/.config/mtxt/${installId}.env`);
const generatedConfig = join(web, `wrangler.${installId}.jsonc`);
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
 * API refuses wrangler's token. Returns null when `cf` is missing or the call fails.
 */
function cf(args) {
  const result = spawnSync('cf', args, {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
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
    errors: (json.errors ?? []).map((e) => `${e.code} ${e.message}`),
  };
}
const account = (path) => `/accounts/${accountId}${path}`;

// ---------------------------------------------------------------- JSONC

/** wrangler.jsonc to JSON: drops comments and trailing commas, leaves strings alone. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// ---------------------------------------------------------------- secrets file

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function appendEnvFile(path, entries) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const head = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  const note =
    '# Generated by deploy/install.mjs. The Worker holds the same values; losing\n' +
    '# MTXT_SETTINGS_KEY makes the sealed settings unreadable (deploy/README.md).\n';
  writeFileSync(
    path,
    `${head}${head && !head.endsWith('\n') ? '\n' : ''}${note}${lines.join('\n')}\n`,
  );
  chmodSync(path, 0o600);
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

  const zones = await api(`/zones?account.id=${accountId}&per_page=50&status=active`);
  if (!zones.ok) fail(`cannot list zones: ${zones.errors.join('; ')}`);
  found.zone = zones.result
    .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];

  const dbs = await api(account(`/d1/database?name=${names.database}&per_page=100`));
  if (!dbs.ok) fail(`cannot list D1 databases: ${dbs.errors.join('; ')}`);
  found.database = dbs.result.find((d) => d.name === names.database);

  const euBuckets = await api(account('/r2/buckets?per_page=1000'), {
    headers: { 'cf-r2-jurisdiction': 'eu' },
  });
  const plainBuckets = await api(account('/r2/buckets?per_page=1000'));
  if (!euBuckets.ok || !plainBuckets.ok) fail('cannot list R2 buckets.');
  found.bucket = euBuckets.result.buckets.find((b) => b.name === names.bucket);
  found.bucketOutsideEu = plainBuckets.result.buckets.find((b) => b.name === names.bucket);

  const queues = await api(account('/queues?per_page=100'));
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
      const out = cf(['ai-gateway', 'gateways', 'list']);
      const list = out === null ? null : JSON.parse(out.slice(out.indexOf('[')));
      if (list) {
        found.gatewayVia = 'cf';
        found.gateway = list.some((g) => g.id === names.gateway) ? 'exists' : 'missing';
      }
    }
  }

  const scripts = await api(account('/workers/scripts'));
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
      AI_GATEWAY_ID: gatewayId ?? '',
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
 * What the Worker is built from: the git trees of apps/web and packages, the
 * lockfile and the generated config. A commit that touches only docs or deploy/
 * keeps the tag, so a run after it deploys nothing.
 */
function desiredTag(configText) {
  const commit = git(['rev-parse', '--short=12', 'HEAD']) || 'nogit';
  const inputs = git(['rev-parse', 'HEAD:apps/web', 'HEAD:packages', 'HEAD:pnpm-lock.yaml']);
  const dirty =
    git(['status', '--porcelain', '--', 'apps/web', 'packages', 'pnpm-lock.yaml']) !== '';
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

async function main() {
  if (flags.status) return status();

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
      if (out === null) problem = 'the cf CLI refused the create';
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

await main();
