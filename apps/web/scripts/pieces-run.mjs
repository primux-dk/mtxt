#!/usr/bin/env node
/*
  A real run of a long recording through the install's provider (packet 18):
  signs in with the e2e build's test sign-in, uploads the file in 8 MiB
  chunks, follows the recording until it is transcribed or failed, and
  prints one JSON summary: sizes and timings. The segments are read from
  the local D1 afterwards (wrangler d1 execute --local).

    node scripts/pieces-run.mjs --url http://localhost:8799 --file speech.webm --type audio/webm

  Only an MTXT_E2E_BUILD=1 Worker answers the test sign-in. Run it against
  `wrangler dev` without --local, so the AI binding is remote, never against
  a deployed install.
*/
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8799' },
    file: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string', default: 'Pieces run' },
    seconds: { type: 'string' },
  },
});
if (!values.file || !values.type) throw new Error('--file and --type are required');
const base = values.url.replace(/\/$/, '');
const audio = readFileSync(values.file);

const signIn = await fetch(`${base}/api/test/sign-in`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'jonas.skov@example.com', name: 'Jonas Skov', admin: false }),
  redirect: 'manual',
});
if (!signIn.ok) throw new Error(`sign-in: ${signIn.status} ${await signIn.text()}`);
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const headers = { cookie };

const created = await fetch(`${base}/api/v1/recordings`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    meeting: { title: values.title, started_at: new Date().toISOString() },
    duration_s: Number(values.seconds ?? 0) || 1,
    sha256: createHash('sha256').update(audio).digest('hex'),
    size_bytes: audio.length,
    source: 'upload',
    content_type: values.type,
  }),
});
if (!created.ok) throw new Error(`create: ${created.status} ${await created.text()}`);
const { id, meeting_id } = await created.json();
const CHUNK = 8 * 1024 * 1024;
const uploadStart = Date.now();
for (let n = 0; n * CHUNK < audio.length; n++) {
  const put = await fetch(`${base}/api/v1/recordings/${id}/chunks/${n + 1}`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: audio.subarray(n * CHUNK, (n + 1) * CHUNK),
  });
  if (!put.ok) throw new Error(`chunk ${n + 1}: ${put.status} ${await put.text()}`);
}
const complete = await fetch(`${base}/api/v1/recordings/${id}/complete`, {
  method: 'POST',
  headers,
});
if (!complete.ok) throw new Error(`complete: ${complete.status} ${await complete.text()}`);
const confirmedAt = Date.now();

let status = '';
let recording = null;
while (Date.now() - confirmedAt < 60 * 60_000) {
  recording = await (await fetch(`${base}/api/v1/recordings/${id}`, { headers })).json();
  if (recording.status !== status) {
    status = recording.status;
    console.error(`${Math.round((Date.now() - confirmedAt) / 1000)} s: ${status}`);
  }
  if (status === 'transcribed' || status === 'failed') break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(
  JSON.stringify(
    {
      file: values.file,
      type: values.type,
      bytes: audio.length,
      recording: id,
      meeting: meeting_id,
      status,
      failure: recording?.failure ?? null,
      upload_s: Math.round((confirmedAt - uploadStart) / 1000),
      transcribe_s: Math.round((Date.now() - confirmedAt) / 1000),
    },
    null,
    2,
  ),
);
