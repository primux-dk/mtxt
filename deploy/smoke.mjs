#!/usr/bin/env node
// Checks an install's public endpoints from outside. No login, no data written.
//
//   node deploy/smoke.mjs <hostname> [--product "Acme Meetings"]
//
// Exits 1 when a check fails. Every check is a request any visitor could make.
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { product: { type: 'string' } },
});
const host = positionals[0]?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
if (!host) {
  console.error('Usage: node deploy/smoke.mjs <hostname> [--product "Product name"]');
  process.exit(2);
}
const origin = `https://${host}`;

const checks = [
  {
    name: 'GET /login renders the login page',
    async run() {
      const res = await fetch(`${origin}/login`, { redirect: 'manual' });
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
    async run() {
      const res = await fetch(`${origin}/design`, { redirect: 'manual' });
      const to = res.headers.get('location') ?? '';
      if (res.status < 300 || res.status > 399) return `status ${res.status}`;
      return new URL(to, origin).pathname === '/login' ? null : `redirects to ${to}`;
    },
  },
  {
    name: 'GET / redirects to the login',
    async run() {
      const res = await fetch(`${origin}/`, { redirect: 'manual' });
      const to = res.headers.get('location') ?? '';
      if (res.status < 300 || res.status > 399) return `status ${res.status}`;
      return new URL(to, origin).pathname === '/login' ? null : `redirects to ${to}`;
    },
  },
  {
    name: 'POST /api/v1/webhooks/assemblyai without the secret is 401',
    async run() {
      const res = await fetch(`${origin}/api/v1/webhooks/assemblyai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript_id: 'smoke-test', status: 'completed' }),
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
  {
    name: 'POST /api/v1/recordings without a session is 401',
    async run() {
      const res = await fetch(`${origin}/api/v1/recordings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
  {
    name: 'GET /api/v1/recordings/{id}/audio without a session is 401',
    async run() {
      const res = await fetch(`${origin}/api/v1/recordings/smoke-test/audio`, {
        redirect: 'manual',
      });
      return res.status === 401 ? null : `status ${res.status}`;
    },
  },
];

let failed = 0;
for (const check of checks) {
  let problem;
  try {
    problem = await check.run();
  } catch (error) {
    problem = (error.cause ?? error).message ?? String(error);
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
