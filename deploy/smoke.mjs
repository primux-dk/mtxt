#!/usr/bin/env node
// Checks an install's public endpoints from outside. No login, no data written.
//
//   node deploy/smoke.mjs <hostname> [--product "Acme Meetings"]
//   node deploy/smoke.mjs http://localhost:8787   a local server, over http
//
// Exits 1 when a check fails. Every check is a request any visitor could make, and
// each one, its body included, has 10 s before it counts as failed.
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { product: { type: 'string' } },
});
const arg = positionals[0] ?? '';
// An install is checked over https; http only for a local server (pnpm preview).
const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(arg);
const host = arg.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!host) {
  console.error('Usage: node deploy/smoke.mjs <hostname> [--product "Product name"]');
  process.exit(2);
}
const origin = local ? `http://${host}` : `https://${host}`;
const TIMEOUT_MS = 10_000;

/** A redirect to this host's /login, not to a /login anywhere. */
function toLogin(res) {
  if (res.status < 300 || res.status > 399) return `status ${res.status}`;
  const to = new URL(res.headers.get('location') ?? '', origin);
  return to.origin === origin && to.pathname === '/login' ? null : `redirects to ${to.href}`;
}

const checks = [
  {
    name: 'GET /login renders the login page',
    async run(signal) {
      const res = await fetch(`${origin}/login`, { redirect: 'manual', signal });
      const body = await res.text();
      if (res.status !== 200) return `status ${res.status}`;
      if (!res.headers.get('content-type')?.includes('text/html')) return 'not HTML';
      if (values.product && !body.includes(values.product)) {
        return `no "${values.product}" on the page`;
      }
      return null;
    },
  },
  {
    name: 'GET /design redirects to the login',
    async run(signal) {
      return toLogin(await fetch(`${origin}/design`, { redirect: 'manual', signal }));
    },
  },
  {
    name: 'GET / redirects to the login',
    async run(signal) {
      return toLogin(await fetch(`${origin}/`, { redirect: 'manual', signal }));
    },
  },
  {
    name: 'POST /api/v1/webhooks/assemblyai without the secret is 401',
    async run(signal) {
      const res = await fetch(`${origin}/api/v1/webhooks/assemblyai`, {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript_id: 'smoke-test', status: 'completed' }),
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
  {
    name: 'POST /api/v1/recordings without a session is 401',
    async run(signal) {
      const res = await fetch(`${origin}/api/v1/recordings`, {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
  {
    name: 'GET /api/v1/recordings/{id}/audio without a session is 401',
    async run(signal) {
      const res = await fetch(`${origin}/api/v1/recordings/smoke-test/audio`, {
        redirect: 'manual',
        signal,
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
];

let failed = 0;
for (const check of checks) {
  let problem;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    problem = await check.run(controller.signal);
  } catch (error) {
    problem = controller.signal.aborted
      ? `no answer within ${TIMEOUT_MS / 1000} s`
      : ((error.cause ?? error).message ?? String(error));
  } finally {
    clearTimeout(timer);
  }
  if (problem) failed++;
  console.log(`${problem ? 'FAIL' : 'ok  '}  ${check.name}${problem ? `: ${problem}` : ''}`);
}
console.log(
  failed
    ? `\n${failed} of ${checks.length} checks failed on ${origin}.`
    : `\nAll ${checks.length} checks passed on ${origin}.`,
);
process.exit(failed ? 1 : 0);
