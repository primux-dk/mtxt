# mtxt

Meeting transcription a company hosts itself. A small recorder on each employee's machine, one web app in the company's own Cloudflare account, and every meeting becomes a transcript and an editable recap in the company's library: private or shared inside the company, and open to the company's AI tools through MCP.

Meetings only. No dictation.

**Status: the v0.1 library runs; MCP is not built yet.** The library works end to end: company login, upload, the browser recorder, transcription with AssemblyAI (EU) or Workers AI Whisper, keyterms, speakers, the recap editor with versions and export, private and shared meetings, retention, the audit log, search, outbound webhooks and a REST API with personal API tokens. The MCP server comes next and wraps that API. The deploy tooling creates and updates an install in a company's own Cloudflare account, and the macOS recorder builds; Windows comes later. The author's own install runs at `app.mtxt.co`. The spec is in [docs/spec.md](docs/spec.md), the decisions behind it in [docs/decisions.md](docs/decisions.md). Every install runs in the owning company's own cloud account; nobody hosts it for anyone else.

## What it does

1. **Company login.** OIDC against Entra ID or Google Workspace. No local users.
2. **Desktop recorder.** Microphone plus system audio on Mac and Windows, bot-free, so a participant in someone else's Teams or Meet still gets a recording. Our own code, with [Vibe](https://github.com/thewh1teagle/vibe), [anarlog](https://github.com/fastrepl/anarlog) and [Meetily](https://github.com/Zackriya-Solutions/meetily) as references for capture and local models.
3. **Live transcript.** Optional, off by default, a local model in the recorder. A preview, never the record.
4. **Other capture.** Record in the browser, upload a file, and pull Teams or Meet recordings for meetings the company organised.
5. **Swappable speech-to-text.** AssemblyAI, Azure Speech, ElevenLabs Scribe, or a local Whisper or Parakeet model. One per install, chosen by the company's own contract.
6. **Keyterms and corrections.** A company dictionary. Danish first.
7. **Speakers.** Diarization, renaming, and labels that can link to a colleague in the directory.
8. **Recap.** The AI drafts it from a template; the owner finishes it in a Notion-style editor inside the platform. Markdown stored, a version per save, AI text and human edits told apart. Export markdown and docx.
9. **Private and shared.** Each meeting is private, shared with named colleagues, or company-wide. Search and MCP respect it.
10. **Retention, audit, MCP.** Delete after N days per install with a keep flag per meeting. A log of who opened what. An MCP server with the same company login, scoped to what the user may see, with read and write tools.

## Stack

- Library: Next.js with shadcn/ui, deployed to Cloudflare Workers in the company's own account: R2 for audio, Queues for jobs, Durable Objects for upload sessions, D1 for data, AI Gateway in front of the language model. Storage, queue and database sit behind adapters so a Docker edition stays possible. The recap editor is Tiptap core with the open React UI components.
- Recorder: Tauri 2 and Rust, our own code under `apps/recorder` in this repo. The library is `apps/web`; the contract between them is `packages/contract`.
- Speech-to-text and language models are adapters. The app holds no opinion about the provider.

## Run it

Prerequisites: Node 22 and pnpm 12 (`corepack enable` picks the version in `package.json`). No Cloudflare account is needed to run locally; wrangler emulates D1, R2, Queues and Durable Objects on disk under `apps/web/.wrangler`.

```sh
pnpm install
pnpm db:migrate      # apply packages/adapters/migrations to the local D1
pnpm db:seed         # write the default settings row (idempotent)
pnpm db:seed --demo  # optional: a demo library of 2,000 meetings (--demo=30 for fewer)
cp apps/web/.dev.vars.example apps/web/.dev.vars   # then fill in the secrets
pnpm dev             # next dev on http://localhost:3000, with the local bindings
```

Every page needs a company login. `apps/web/.dev.vars` holds `AUTH_SECRET`, `SETTINGS_KEY` and the first OIDC values (an Entra ID or Google app registration); the comments in `.dev.vars.example` say what each is. Without them the login page names the ones missing. The first person to sign in becomes the install's first admin.

- `pnpm preview` builds the Worker with OpenNext and serves it with `wrangler dev --local` on http://localhost:8787: the same code that deploys. Uploads and the browser recorder need it: the upload sessions are a Durable Object in the Worker, which `next dev` cannot reach. The demo library belongs to three seeded users whose subjects are the e2e sign-in's (`test|<email>`); in an e2e build, signing in as one of them opens their meetings.
- The recap is drafted after each transcript by the install's recap model (Settings, "Recap model"): Workers AI with Llama 4 Scout by default, no key needed, or Anthropic, OpenAI or Azure OpenAI with a key. Like Whisper, Workers AI runs only remotely, so under `wrangler dev --local` a draft fails with that reason and the recap tab offers Try again; the e2e run drafts with a fake model instead. The owner edits the recap in the meeting's Recap tab; it saves itself.
- Transcription needs a provider chosen in Settings. Locally, AssemblyAI calls back to the install's `PUBLIC_URL` (a var in `wrangler.jsonc`), which must be reachable from AssemblyAI; Workers AI always runs remotely, so `wrangler dev --local` has none and a Workers AI job fails with that reason. `MTXT_REMOTE_BINDINGS=1 pnpm dev` turns remote bindings on for `next dev` when wrangler is logged in. Without a provider, a recording waits and starts when one is saved.
- `pnpm stt:compare --recording <id> --provider workers-ai` runs a second provider on a transcribed recording, stores it as a comparison transcript the app never shows, and prints both word counts and a word diff. `--persist-to` and `--vars` point it at other local state, `--remote` at the deployed install.
- `pnpm test` runs the unit tests (Vitest). `pnpm test:e2e` builds the e2e Worker (`build:e2e`, which adds a test-only sign-in), starts `wrangler dev` on a fresh local install with the placeholder secrets in `apps/web/e2e/e2e.vars` and runs the Playwright tests; it needs Chromium for Playwright 1.63 (`pnpm --filter @mtxt/web exec playwright install chromium`).
- Retention runs nightly from a Cron Trigger (03:00 UTC, `wrangler.jsonc`). Locally, `wrangler dev --test-scheduled` (the e2e run uses it) runs it on `GET /__scheduled`.
- `pnpm --filter @mtxt/web check:locales` fails on a key missing in either language, a key the app does not use, or an em dash in either messages file; the unit tests run it too.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:licenses` and `pnpm check:generated` are what CI runs. After `pnpm --filter @mtxt/web build:cf`, `pnpm --filter @mtxt/web check:no-fakes` checks that the deployed Worker carries none of the e2e run's fake providers. `E2E_PORT` moves the e2e server off 8788 when another checkout uses it. `pnpm --filter @mtxt/web check:d1-upgrade` applies the migrations to a populated local D1 and fails if a row is lost.
- After a schema change in `packages/adapters/src/db/schema.ts`, run `pnpm generate` and commit the new migration. After editing `packages/contract/openapi.yaml`, the same command regenerates the contract types.
- `/design` serves the design guidelines rendered with the install's own theme values.

Layout: `apps/web` is the library (Next.js on Cloudflare Workers), `packages/contract` the recorder-to-server contract, `packages/adapters` storage, queue and database behind interfaces. The web app reaches Cloudflare only through `@mtxt/adapters`.

## Webhooks

An install can send its meetings to the company's other systems, such as a CRM or a case system. An admin adds up to five endpoints under Settings, Webhooks, and chooses whether company meetings, all shared meetings or none go out on their own. A private meeting goes only when its owner chooses "Send to connected systems" (or "Send to Alex", after the endpoint's label) on the meeting page. A payload carries metadata and signed links, never the transcript or the recap: the receiving system fetches those through the links, which work for one hour and only while the meeting may still be sent. The events are `meeting.transcribed`, `recap.drafted`, `recap.saved`, `meeting.shared`, `meeting.deleted` and `webhook.test`. A failed delivery is tried again after 1 minute, 10 minutes, 1 hour, 6 hours and 24 hours, six attempts in all, then parked; each endpoint has a delivery log with Retry now. The details are in [docs/spec.md](docs/spec.md#webhooks).

```json
{
  "event": "recap.saved",
  "sent_at": "2026-10-23T10:15:00.000Z",
  "install": { "product_name": "Acme Meetings" },
  "meeting": {
    "id": "6f1c2a34-9d0e-4b7a-8c21-5e3f9a0b1c2d",
    "title": "Production meeting, week 43",
    "started_at": "2026-10-22T09:00:00.000Z",
    "duration_s": 2712,
    "visibility": "company",
    "owner": { "name": "Mette Lund", "email": "mette.lund@example.com" }
  },
  "links": {
    "transcript": "https://meetings.example.com/api/v1/export/v1.6f1c2a34-9d0e-4b7a-8c21-5e3f9a0b1c2d.transcript.1792754100.0a1b2c3d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.<signature>",
    "recap_markdown": "https://meetings.example.com/api/v1/export/v1.6f1c2a34-9d0e-4b7a-8c21-5e3f9a0b1c2d.md.1792754100.0a1b2c3d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.<signature>",
    "recap_docx": "https://meetings.example.com/api/v1/export/v1.6f1c2a34-9d0e-4b7a-8c21-5e3f9a0b1c2d.docx.1792754100.0a1b2c3d-1e2f-4a5b-8c6d-7e8f9a0b1c2d.<signature>"
  },
  "expires_at": "2026-10-23T11:15:00.000Z"
}
```

A link is `null` when there is nothing to fetch yet. `meeting.deleted` carries only `meeting: { id, deleted_at }`, with no links, and goes only to an endpoint that took an earlier event of the meeting. The transcript link answers JSON (`language`, `speakers`, and `segments` with `start_ms`, `end_ms`, `speaker_id` and `text`), the recap links Markdown and Word. A link answers 404 once the meeting may no longer be sent and 410 once it has expired.

Every request carries `X-Mtxt-Signature: t=<unix seconds>,v1=<hex>`, the HMAC-SHA256 of `<t>.<raw body>` with the endpoint's secret, plus `X-Mtxt-Event` and `X-Mtxt-Delivery`, which stays the same on every attempt of a delivery so the receiver can drop a repeat. Check the signature on the raw body before parsing it:

```ts
async function verifyMtxt(rawBody: string, header: string | null, secret: string) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const [, t, v1] = match;
  // Refuse a replay: the timestamp is signed, so it cannot be moved.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const mac = Uint8Array.from(v1!.match(/../g)!, (byte) => parseInt(byte, 16));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${t}.${rawBody}`));
}
```

## API

A company's own system reads meetings, transcripts and recaps through a REST API as one user, with that user's personal API token. It sees what the user sees and nothing more; an admin's token sees nothing extra. Webhooks say when something changed; the API fetches it. [packages/contract/openapi.yaml](packages/contract/openapi.yaml) is the reference, enough to write a client from.

Make a token in the library:

1. Open the menu under your name at the foot of the sidebar and choose **API tokens**.
2. Choose **New token**, give it the name of the system it is for, pick **Read only** or **Read and write**, and how long it lasts (30 days, 90 days or 1 year).
3. Choose **Create token**, then **Copy**. The token is shown this once; the server keeps only its hash. Revoke it in the same dialog when it is no longer needed or has leaked.

Then, with the install's hostname:

```sh
export MTXT=https://meetings.example.com
export TOKEN=mtxt_...

# The meetings you may read, newest first; pass next_cursor back as cursor for the next page.
curl -s "$MTXT/api/v1/meetings?limit=20" -H "Authorization: Bearer $TOKEN"

# One meeting's transcript: JSON with speakers and segments, or plain text.
curl -s "$MTXT/api/v1/meetings/$ID/transcript" -H "Authorization: Bearer $TOKEN"
curl -s "$MTXT/api/v1/meetings/$ID/transcript?format=text" -H "Authorization: Bearer $TOKEN"

# The recap: JSON (body, version, decisions), markdown, or Word.
curl -s "$MTXT/api/v1/meetings/$ID/recap" -H "Authorization: Bearer $TOKEN"
curl -s "$MTXT/api/v1/meetings/$ID/recap?format=markdown" -H "Authorization: Bearer $TOKEN"
curl -s -o recap.docx "$MTXT/api/v1/meetings/$ID/recap?format=docx" -H "Authorization: Bearer $TOKEN"
```

| Call                                      | Scope        | What it does                                                                                              |
| ----------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/meetings`                    | `read`       | Meetings you may read. `view` (`all`, `mine`, `shared`, `company`, `archived`), `q`, `status`, `since`, `cursor`, `limit` |
| `GET /api/v1/meetings/{id}`               | `read`       | One meeting with its recordings, transcript and recap state, and its readers if it is yours               |
| `GET /api/v1/meetings/{id}/transcript`    | `read`       | `?format=json` (default) or `text`                                                                        |
| `GET /api/v1/meetings/{id}/recap`         | `read`       | `?format=json` (default), `markdown` or `docx`                                                            |
| `GET /api/v1/search?q=`                   | `read`       | Titles, transcripts and recaps, best match first, with a snippet                                          |
| `PUT /api/v1/meetings/{id}/recap`         | `read_write` | Save a new version on `base_version_id`; 409 with the current version when it moved on                    |
| `PATCH /api/v1/meetings/{id}`             | `read_write` | Set `title`, `visibility` or `keep` on your own meeting                                                   |
| `POST /api/v1/meetings/{id}/shares`       | `read_write` | Add a reader by `user_id` or `email` to your own Shared meeting                                           |
| `DELETE /api/v1/meetings/{id}/shares/{userId}` | `read_write` | Remove a reader                                                                                      |

60 requests a minute per token; the 61st is 429 with `Retry-After`. Every GET answers with an `ETag`; send it back as `If-None-Match` for a 304 when nothing changed. Each read of one meeting through the API is in the audit log with the token's name.

## Deploy

An install runs in the owning company's own Cloudflare account, on a hostname in one of its zones. One command creates or reuses the D1 database, the R2 bucket, the queues and the AI Gateway, applies the migrations, writes the first settings row, deploys the Worker with its custom domain and sets its secrets:

```sh
mkdir -p deploy/installs
cp deploy/install.example.json deploy/installs/acme.json   # then fill it in
pnpm deploy:install --config deploy/installs/acme.json --dry-run
pnpm deploy:install --config deploy/installs/acme.json
pnpm deploy:smoke meetings.acme.com --product "Acme Meetings"
```

[deploy/README.md](deploy/README.md) is the runbook: prerequisites, the app registration and its redirect URI, rotating secrets, updating, backing up D1, removing an install, and what stays in the EU.

## Recorder

The desktop recorder is `apps/recorder`, a Tauri 2 app in Rust: microphone and system audio, the company login through the browser, a queued upload, and an optional live transcript from a local model. It builds for macOS 14.2 and later, on a Mac, with `pnpm recorder:build`; Windows comes later. [apps/recorder/README.md](apps/recorder/README.md) covers the build, signing, tests and how it works.

## Licence

PolyForm Noncommercial 1.0.0, the same as scene-loop. Free for noncommercial use; a company that runs it in its business needs a commercial licence from Primux. Source-available, not open source in the OSI sense. See [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md) for third-party code and model attributions.

Site: [mtxt.co](https://mtxt.co). Built by [Primux](https://primux.dk).
