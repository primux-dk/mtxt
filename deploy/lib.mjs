// What deploy/install.mjs and deploy/backup.mjs share: the install config and its
// checks, the generated wrangler config, the secrets file and private files.
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const web = join(root, 'apps/web');
export const wranglerBin = join(web, 'node_modules/.bin/wrangler');

/** A planned stop: the scripts catch it, let `finally` blocks run, and exit 1. */
export class Stop extends Error {}
export function fail(message) {
  throw new Stop(message);
}

/** Runs `main`, prints a Stop as one line and exits 1 after every `finally` has run. */
export async function runMain(main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(`\nStopped: ${error.message}`);
    process.exitCode = 1;
  }
}

export const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p));

const DEFAULT_NAMES = {
  worker: 'mtxt-web',
  database: 'mtxt-db',
  bucket: 'mtxt-audio',
  queue: 'mtxt-jobs',
  deadLetterQueue: 'mtxt-jobs-dlq',
  gateway: 'mtxt-gateway',
};

/**
 * The install config, checked. Every resource name starts with `mtxt-`, so the
 * scripts never touch anything else in the account; `names.gateway` may be null.
 */
export function loadInstall(path) {
  if (!path) fail('Pass --config <install.json>. Copy deploy/install.example.json to start.');
  const file = expand(path);
  if (!existsSync(file)) fail(`no install config at ${path}.`);
  const config = JSON.parse(readFileSync(file, 'utf8'));

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

  const names = { ...DEFAULT_NAMES, ...config.names };
  for (const [key, value] of Object.entries(names)) {
    if (key === 'gateway' && value === null) continue;
    if (typeof value !== 'string' || !/^mtxt-[a-z0-9-]{1,58}$/.test(value)) {
      fail(
        `names.${key} must start with mtxt- and hold lowercase letters, digits and -: "${value}"`,
      );
    }
  }

  const settings = config.settings ?? {};
  if (settings.interfaceLanguage && !['en', 'da'].includes(settings.interfaceLanguage)) {
    fail('settings.interfaceLanguage is en or da.');
  }
  if (settings.timeZone !== undefined && !knownTimeZone(settings.timeZone)) {
    fail(
      `settings.timeZone is an IANA time zone such as Europe/Copenhagen: "${settings.timeZone}"`,
    );
  }
  if (settings.identityProvider && !['entra', 'google'].includes(settings.identityProvider)) {
    fail('settings.identityProvider is entra or google.');
  }
  if (
    settings.sttProvider &&
    !['assemblyai', 'elevenlabs', 'workers-ai-whisper'].includes(settings.sttProvider)
  ) {
    fail('settings.sttProvider is assemblyai, elevenlabs or workers-ai-whisper in this version.');
  }

  return {
    configPath: path,
    accountId,
    hostname,
    installId,
    names,
    settings,
    secretsFile: expand(config.secretsFile ?? `~/.config/mtxt/${installId}.env`),
    generatedConfig: join(web, `wrangler.${installId}.jsonc`),
  };
}

/** Whether `zone` is a time zone name Node knows, the same check the settings page makes. */
export function knownTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** wrangler.jsonc to JSON: drops comments and trailing commas, leaves strings alone. */
export function parseJsonc(text) {
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

/**
 * The generated wrangler config, only when it belongs to this install: its account
 * id, its Worker and its database binding must be the install config's. Wrangler
 * gives a config's `account_id` precedence over the shell, so a stale file must stop.
 */
export function readGeneratedConfig(install) {
  const regenerate = `Write it again: pnpm deploy:install --config ${install.configPath} --config-only`;
  if (!existsSync(install.generatedConfig)) {
    fail(`${basename(install.generatedConfig)} is missing. ${regenerate}`);
  }
  const cfg = parseJsonc(readFileSync(install.generatedConfig, 'utf8'));
  const db = cfg.d1_databases?.[0];
  const problems = [
    cfg.account_id !== install.accountId && 'its account_id is not the install config account',
    cfg.name !== install.names.worker && 'its Worker name is not names.worker',
    db?.binding !== 'DB' && 'its first D1 binding is not DB',
    db?.database_name !== install.names.database && 'its database is not names.database',
    !/^[0-9a-f-]{36}$/.test(db?.database_id ?? '') || /^0{8}-/.test(db.database_id)
      ? 'it has no real database id'
      : false,
  ].filter(Boolean);
  if (problems.length) {
    fail(
      `${basename(install.generatedConfig)} does not match the install config: ${problems.join('; ')}. ${regenerate}`,
    );
  }
  return cfg;
}

/**
 * A dotenv file: `NAME=value`, optional `export `, a value in matching quotes kept
 * as written (a # inside stays), an unquoted value ending at ` #` (an inline comment).
 */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2];
    const quoted = raw.match(/^(['"])(.*?)\1(\s+#.*|\s*)$/);
    values[m[1]] = quoted ? quoted[2] : raw.replace(/(^|\s+)#.*$/, '').trim();
  }
  return values;
}

export const readEnvFile = (path) => (existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {});

/**
 * Writes a file that only its owner can read, atomically: a new 0600 file next to it,
 * opened with that mode before any byte is written, then renamed over the old one.
 */
export function writePrivateFile(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
