# mtxt specification

Settled 2026-10-22. Changes go here first, then into code. Decisions and their reasons are in `decisions.md`.

## What it is

One web app that runs in the company's own Cloudflare account, plus a small recorder on each employee's machine. Every meeting becomes a transcript and an editable recap in the company's own library, private or shared inside the company, and open to the company's AI tools through MCP. Meetings only: no dictation.

The product name an employee sees is a setting per install ("Acme Meetings"). mtxt appears only in About and on GitHub.

The interface is written in English and translated. English is the source of every string, in the library and in the recorder; Danish is the first translation. A user gets the interface in the browser's or operating system's language when a translation exists, otherwise in the install's default interface language. Interface language and transcription language are separate settings.

## Scope: 10 features

| #   | Feature                  | What it means                                                                                                                                                                                                                         |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Company login            | OIDC against Entra ID or Google Workspace. No local users, no passwords.                                                                                                                                                              |
| 2   | Desktop recorder         | Mic plus system audio on Mac and Windows, bot-free. Signed in with the company login, uploads when the meeting ends. Our own Tauri 2 and Rust app, with Vibe, anarlog and Meetily as references.                                      |
| 3   | Live transcript          | Text on screen while the meeting runs, in a small floating window, always on top. A per-user setting with an admin default, off by default. Runs a local model in the recorder. A preview only; the server transcript is the record.  |
| 4   | Other capture            | Record in the browser, upload a file, share from a voice recorder. Pull Teams and Meet recordings for meetings the company organised.                                                                                                 |
| 5   | STT adapter              | AssemblyAI, Azure Speech, ElevenLabs Scribe, local Whisper or Parakeet. One per install, swappable.                                                                                                                                   |
| 6   | Keyterms and corrections | One company dictionary per install: product names, people, jargon. CSV import. Danish first.                                                                                                                                          |
| 7   | Speakers                 | Diarization, renaming, voice memory per install where the provider allows it. Labels can link to a directory user.                                                                                                                    |
| 8   | Recap                    | AI drafts from the chosen template; the owner edits in a Notion-style Tiptap editor inside the platform. Markdown stored, a version per save, AI text and human edits told apart. Export md and docx. Search across what you may see. |
| 9   | Private and shared       | Each meeting is private, shared with named colleagues, or company-wide. Admin sets the default. Only the owner changes it. Search and MCP respect it.                                                                                 |
| 10  | Retention, audit, MCP    | Delete after N days per install, with a keep flag per meeting. A log of who opened what. MCP server with the same company login, scoped to what the user may see.                                                                     |

Not in scope: dictation of any kind, hotkeys, push-to-talk; a bot that joins calls; snippets, user-selectable themes beyond the install's two colours, a plugin marketplace, a premium tier, widgets, per-user LLM settings.

## Capture routes, in build order

1. **Desktop recorder.** The only route that covers a meeting someone else organised. Our own code: Core Audio process tap on Mac, WASAPI loopback on Windows, whisper.cpp and Parakeet for the live preview, the way Vibe, anarlog and Meetily do it.
2. **Browser and upload.** A recorder in the browser and file upload, in v0.1. A phone app later.
3. **Pull platform recordings.** Teams recordings through Microsoft Graph (`getAllRecordings`, application permission `OnlineMeetingRecording.Read.All`, admin consent plus an application access policy; organiser's recordings only). Meet recordings through the Meet REST API and a Drive download. Only for meetings the company organised.
4. **Meeting bot.** Avoided. Visible, brittle, per-minute cost.

## Settings page

The whole admin surface. If a setting is not here, it does not exist. The page is organised in tabs, one route per tab under `/settings/` (General, Login, Transcription, Recap, Sharing and retention, Webhooks, Audit log), and together they are still the whole admin surface. `/settings/audit`, the audit log, is part of it: a paged table of events (user, meeting title, action, time), filtered by action and user, for admins only. It shows titles and owners, never content.

| Setting                 | Values                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product name            | Free text, shown on the recorder, the login page and the tray                                                                                                                                                                                                                                                                                                                                                                                        |
| Company name            | Free text, shown under the product name in the sidebar and in the login footer ("An installation for Acme A/S")                                                                                                                                                                                                                                                                                                                                      |
| Theme                   | Accent colour and button colour, two hex values. Defaults are sage #566b45 and #111111. Tints, lines, focus ring and the dark mode are derived. Three pairs are checked in both themes, accent text on the background, button text on the button, accent on a card; a value that puts any pair under 4.5:1 is refused with the ratio shown. A preview row under the fields shows the derived states. The recorder reads the same two values at login |
| Identity provider       | Entra ID or Google: tenant id (for Entra, the tenant's GUID; for Google, the Workspace domain), client id, secret. The secret is stored encrypted and never shown again                                                                                                                                                                                                                                                                              |
| Speech-to-text provider | AssemblyAI (EU), Azure Speech (region), ElevenLabs Scribe, Workers AI Whisper, local Whisper or Parakeet: key, region. Workers AI and the local models need no key. The key is stored encrypted and never shown again. v0.1 transcribes with AssemblyAI, ElevenLabs Scribe and Workers AI Whisper; the others stay in the list and are refused at save with "Not available in this version". ElevenLabs takes a key and no region" |
| AI Gateway              | Gateway id in the company's Cloudflare account, optional. Workers AI, and the recap model from v0.1 packet 5, go through it when set                                                                                                                                                                                                                                                                                                                 |
| Recap model             | Provider and model behind AI Gateway: Workers AI (default, no key), Anthropic, OpenAI, Azure OpenAI; key sealed; model id free text with a sensible default per provider |
| Interface language      | Default for the install: en or da. A user's browser or OS language wins when a translation exists                                                                                                                                                                                                                                                                                                                                                    |
| Default language        | For transcription. ISO code, auto-detect allowed                                                                                                                                                                                                                                                                                                                                                                                                     |
| Time zone               | IANA name (`Europe/Copenhagen`), UTC by default. The calendar day a meeting falls on, for due dates the recap draft works out from "on Thursday" or "tomorrow" |
| Keyterms                | One list per install, CSV import                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Live transcript         | On by default: yes or no. Users can switch it for themselves                                                                                                                                                                                                                                                                                                                                                                                         |
| Default visibility      | private, shared, company                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Recording sources       | Desktop, upload, browser, OneDrive (Teams), Drive (Meet)                                                                                                                                                                                                                                                                                                                                                                                             |
| Recap templates         | Several per install, markdown, admin edits, user picks per meeting                                                                                                                                                                                                                                                                                                                                                                                   |
| Retention               | Audio N days, transcripts and recaps N days                                                                                                                                                                                                                                                                                                                                                                                                          |
| MCP server              | Enabled: yes or no                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Webhooks                | Up to five endpoints per install: URL (https only), a signing secret shown once, events to send, enabled. Payloads are JSON, signed with HMAC-SHA256 over the raw body in `X-Mtxt-Signature` (`t=<unix>,v1=<hex>`), retried with backoff (1 min, 10 min, 1 h, 6 h, 24 h), six attempts in all, then parked; an admin sees the delivery log per endpoint |
| Send automatically      | `off`, `company` (meetings with company visibility), `all shared` (company or shared). Private meetings are never sent automatically; their owner sends one with "Send to connected systems" |
| Admins                  | Email list. The first user to sign in on a fresh install becomes admin; admins edit the list                                                                                                                                                                                                                                                                                                                                                         |

## How a recording reaches the library

```
Recorder                         Platform                        STT provider
   |-- POST /recordings ----------->|  (meeting, duration, sha256, size)
   |<-- recording id, upload url ---|
   |-- PUT chunk 1..n (8 MB) ------>|  resumable
   |-- POST /recordings/{id}/complete
   |                                |-- verify sha256
   |<-- confirmed ------------------|
   |   keep local file 7 days,      |-- audio + keyterms ---------->|
   |   then delete                  |<-- transcript, speakers ------|
   |                                |-- recap from template, audit event
   |-- GET /recordings/{id} ------->|  poll
   |<-- status: transcribed --------|
```

Each chunk is one part of a multipart upload in R2, tracked by an upload session (a Durable Object per recording, EU jurisdiction). The file lands at `recordings/{install_id}/{meeting_id}/{recording_id}.{ext}`. `GET /recordings/{id}` lists `chunks_received` while uploading, so an interrupted upload resumes with the chunks the server lacks. A recorder that uploads while it records (the browser recorder) leaves `sha256` and `size_bytes` out of the create request and sends them with complete. A session admits one chunk at a time: a second PUT meanwhile answers 409 `busy` with `Retry-After: 1`, and the body of a refused chunk is never read. A chunk is `application/octet-stream`, at most 8 MiB, read no further than one byte past that. A session not completed within 7 days is aborted and the recording is `failed` with `session_expired`. On confirm the platform queues a transcribe job and the status moves to `transcribing`. The job sends the audio and the keyterms to the install's provider. A synchronous provider (Workers AI Whisper, ElevenLabs Scribe) answers at once; an async one (AssemblyAI) calls `POST /api/v1/webhooks/assemblyai` with the install's webhook secret in a custom header, and the job then fetches the result. The transcript, the meeting's speakers and the segments are written in one batch, the status moves to `transcribed`, and a recap job is queued. A delivery claims the transcript row before it calls the provider, so two deliveries never both submit, and a delivery that finds a live claim comes back when it lapses; and an async job is also checked after 5 minutes in case the webhook never comes. The provider's raw result is kept in storage, not in D1. A provider error worth retrying goes back to the queue, three deliveries at most; any other fails the recording with a fixed reason and keeps the audio. A provider's own error text is never logged or stored. With no provider chosen, a recording waits in `transcribing`, and saving a provider queues a drain job that queues the waiting ones, 100 at a time. The webhook body is at most 64 KiB, and `PUBLIC_URL` is a bare https origin. Audio is never on a public URL: the library streams it from `GET /api/v1/recordings/{id}/audio`, with Range support, after the permission check.

"Confirmed" means the platform holds the whole file and its hash matches. Only then does the recorder's 7-day local timer start. Without a confirm the recorder keeps the file and retries; it warns the user after 24 hours and asks the user after 7 days.

Recorder states per recording: Recording, Uploading, Pending (no network), Warn (24 h), AskUser (7 d), Confirmed, Deleted (7 d after confirm). A recording belongs to the user who was connected when it was made: the recorder uploads it only with that user's token, to the install it was recorded for.

## Recorder connection

A recorder connects through the browser, with the company login the library already has. It never sees an identity provider's credentials or secrets; the web app stays the only OIDC client.

1. The recorder makes a random code verifier (32 random bytes, base64url, 43 characters) and its challenge, the base64url SHA-256 of the verifier (RFC 7636 S256, 43 characters).
2. It opens `https://<host>/connect?challenge=<challenge>&name=<device name>` in the default browser. The device name is 1 to 64 characters, no control characters; the recorder shortens a longer one.
3. The user signs in with the company login (an existing session, or the normal login redirect and back) and sees "Connect <device name> to <product name>?" with the user's name, the pairing code, "Only approve a connection you just started in your own recorder. If you did not, press Cancel.", Approve (the one primary) and Cancel. Approve and Cancel are server actions, so the page is CSRF-safe. The recorder shows the same pairing code next to "Waiting for approval". The code is six characters, `XXX-XXX`: the first 30 bits of SHA-256 of the challenge's ASCII bytes, in six 5-bit groups from the most significant, each mapped through Crockford's base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Both sides derive it from the challenge, so the server keeps no state for it.
4. On Approve the server stores a pending grant keyed by the challenge, bound to the user and the device name, for 10 minutes. Cancel stores a denied grant. A challenge is used once: a second Approve or Cancel changes nothing. A user has at most 20 pending grants.
5. Meanwhile the recorder polls `POST /api/v1/recorder/token` with the challenge and the verifier, every 2 seconds. A poll for a challenge with no grant costs one database read and writes nothing. It gets 202 while no grant exists, 200 with a token once, and 410 when the grant expired, was denied, was already used, or the verifier does not match the challenge. The recorder gives up after 10 minutes on its own. One poll per second per approved grant; a faster one gets 429 with `Retry-After`.
6. The token goes with every API call as `Authorization: Bearer <token>`. It is `mtxt_` and 32 random bytes in base64url, valid 180 days, bound to one user and one device name, and revocable. The token response also carries the install's product name, the two theme colours, the default interface language, the live transcript default and the user's id, name and address, so the recorder brands and sets itself up without a second call.

The approval is not bound to the browser that the recorder opened. Anyone who makes a verifier can send a signed-in user a `/connect` link, and if that user approves it, the sender's poll receives a token for the user. Two things stand against that: the pairing code, which the user compares with the code on their own recorder, and the wording above the buttons. A token that was approved by mistake shows under Recorders, where the user disconnects it.

The server keeps only the SHA-256 of a token, never the token, and never logs it. A call with a bearer token resolves the token's user row the same way a session cookie does: the row decides email and admin. A bad, expired or revoked token is 401 in the contract's error shape, never a login redirect. `last_used_at` is written at most once per 5 minutes.

The nightly retention job deletes recorder grants that expired over a day ago and tokens revoked or expired over 90 days ago.

A user sees their recorders under the user slot's menu, "Recorders": device name, connected since, last used, and Disconnect. Disconnect revokes the token at once; the recorder's next call gets 401. The recorder can disconnect itself with `DELETE /api/v1/recorder/tokens/{id}`, for its own token only; a recorder never revokes another of the user's recorders. Admins see nothing extra; the audit log gets `recorder_connected` and `recorder_disconnected`. A recorder connection is the user's own, so the settings page has no row for it.

## API

A company's own systems (a CRM, a case system) read meetings, transcripts and recaps through a REST API, as a user, with a personal API token. Webhooks say when something changed; the API is where the content is fetched. There is still no install-level service identity: a token is one user's, and it sees what that user sees, nothing more. Admins get nothing extra.

- **Tokens.** A user makes them under the user slot's menu, "API tokens": a name (1 to 64 characters, the device-name rules), a scope (`read`, or `read_write`), and a lifetime of 30 days, 90 days or 1 year (the default). The token is `mtxt_` and 32 random bytes in base64url, the recorder token's shape, shown once with a copy button; the server keeps only its SHA-256 and never logs it. The list shows name, scope, created, expires and last used, and Revoke, which stops the token at once. At most 25 working tokens per user. Tokens are rows in `recorder_tokens` with `kind` `api` and a `scope`, so one bearer lookup, one `last_used_at` rule (at most once per 5 minutes) and one nightly prune serve both kinds; the Recorders list and the API tokens list each show and revoke only their own kind. The audit log gets `api_token_created` and `api_token_revoked` with the name and scope.
- **Calls.** `https://<host>/api/v1/...` with `Authorization: Bearer <token>`, JSON in and out, the contract's error shape. A missing, unknown, expired or revoked token is 401; a recorder's token on an API path, or an API token on a recorder path, is 403; a write with a `read` token is 403 `insufficient_scope`. A meeting the user may not read is 404, as if it did not exist; a write to a meeting the user reads but does not own is 403. 60 requests a minute per token, counted in D1 in a window that starts with the minute's first request; the 61st is 429 with `Retry-After`, and every answer carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Lists page with an opaque `cursor` and `next_cursor` (null at the end), `limit` 1 to 100, 50 by default. Every GET answers with a strong `ETag` over the body; `If-None-Match` with it is 304 and no body.
- **Endpoints.** `GET /meetings` (`view` `all` (default), `mine`, `shared`, `company`, `archived`; `q`; `status` `ready`, `transcribing`, `failed`; `since`, an ISO time the meeting started at or after; newest first), `GET /meetings/{id}`, `GET /meetings/{id}/transcript` (JSON with speakers and segments; `?format=text` for plain text), `GET /meetings/{id}/recap` (`?format=json` (default: body, version and decisions), `markdown`, `docx`), `GET /search?q=` (best match first, a snippet per meeting). With `read_write`: `PUT /meetings/{id}/recap` (the editor's own save, on a base version), `PATCH /meetings/{id}` (title, visibility, keep; owner only), `POST /meetings/{id}/shares` (a colleague by id or address; owner only, the meeting must be Shared) and `DELETE /meetings/{id}/shares/{userId}`. `packages/contract/openapi.yaml` is the reference.
- **MCP mapping.** The v0.3 MCP tools wrap these calls one to one: `list_meetings` is `GET /meetings`, `get_transcript` is `GET /meetings/{id}/transcript`, `get_minutes` is `GET /meetings/{id}/recap`, `search` is `GET /search`, `save_minutes` is `PUT /meetings/{id}/recap`, `set_visibility` is `PATCH /meetings/{id}` with `visibility`, `share` is `POST` or `DELETE /meetings/{id}/shares`.
- **Audit.** Every read of one meeting through the API is an audit row with `via: api` and the token's name, the owner's own reads included: `GET /meetings/{id}` is `opened` (once per user, meeting and hour, counted apart from the page's opens), a transcript or a recap is `exported` with its format. A 304 writes nothing. Lists and search write nothing, as the library's do. A write is its existing action with `via: api`: `visibility_changed` and `shared`. A rename, the keep flag and a recap save have no audit action in the library either; a recap version names its author.

## Local models in the recorder

Downloaded from Hugging Face directly on first run. Parakeet TDT 0.6B v3 (CC-BY-4.0, includes Danish) is the default; Whisper large-v3-turbo (MIT) is the fallback. Both switchable in the recorder. The live transcript is discarded when the meeting ends.

## Stack and deployment

- `apps/web`: Next.js, shadcn/ui, Drizzle ORM. Deployed to Cloudflare Workers with OpenNext.
- Interface strings live in locale files, one set per app (`apps/web` and `apps/recorder` each hold their own), English as the source and Danish as the first translation. No string is hard-coded in a component.
- The look is defined once in `docs/design/` (README, `tokens.css`, `guidelines.html`, mockups). `apps/web` serves the guidelines at `/design` for signed-in users, rendered from the install's live tokens, so an install with its own accent sees its own page. Every colour in the app derives from the two theme values plus the fixed neutral scale; no component carries a literal colour.
- Cloudflare bindings in the company's own account: R2 for audio and exports, Queues for transcription and recap jobs, Durable Objects for resumable upload sessions, D1 for the database, AI Gateway in front of the language model used for recaps, Workers AI as one of the speech-to-text adapters.
- Identity: OIDC against Entra ID or Google Workspace through Auth.js or an equivalent; no local users.
- MCP: a remote MCP server on Workers with OAuth, using Cloudflare's agents SDK.
- Every install is single-company, in that company's own account. Primux deploys and holds no data. A Docker edition (S3-compatible storage, database-backed queue, SQLite or Postgres) is possible through `packages/adapters` but is not part of v0.1.
- Deploy: `deploy/install.mjs` creates or reuses an install's resources by name in the account it is given, applies the migrations, writes the first settings row, deploys the Worker on a custom domain (no `workers.dev` URL) and sets its secrets; a second run changes nothing. `deploy/README.md` is the runbook.
- Domains: `mtxt.co` is the marketing site, `app.mtxt.co` is the author's own install. A customer's install runs on a hostname in the customer's own zone (for example `meetings.customer.com`), in the customer's own account.
- EU data, checked 2026-10-22 against Cloudflare's data-localization docs and again 2026-10-23: audio at rest is pinned with R2 jurisdictional restrictions (EU), upload sessions with Durable Object jurisdiction `eu`, and the D1 database and the queues are created with jurisdiction `eu`; all of them work without an Enterprise plan. A D1 or queue jurisdiction is set at creation and cannot be added later. Where Worker code runs is best effort (the nearest data centre to the request) unless the customer has the Data Localization Suite, an Enterprise-only add-on. Workers AI and AI Gateway are not covered by Regional Services. State this plainly in the admin's data-flow page; do not promise EU-only processing.
- AI Gateway, checked 2026-10-22: proxies ElevenLabs, Deepgram, Workers AI, OpenAI, Azure OpenAI, Anthropic, Google, Mistral and others. AssemblyAI is not a supported provider, so that adapter calls AssemblyAI directly; the gateway fronts the recap model and the providers it supports.

## Data model

One database per install, in the company's own account. Every row carries an install id for safety; v1 runs one company per install and no code assumes otherwise.

```
users            id, oidc_subject, email (one user per address), name, is_admin
meetings         id, owner_id, title, title_folded, started_at, visibility (private|shared|company),
                 keep (bool), template_id, archived_at, deleted_at,  -- archived: out of the views, restorable
                 webhook_consent_at                                   -- the owner's "Send to connected systems"; null after Private
meeting_shares   meeting_id, user_id                       -- "shared" visibility only
recordings       id, meeting_id, uploaded_by, source (desktop|browser|upload|teams|meet|device),
                 is_primary, duration_s, sha256, size_bytes, content_type, storage_path,
                 status (uploading|confirmed|transcribing|transcribed|failed), failure, failure_reason,
                 created_at, confirmed_at, delete_audio_at
                 -- sha256 '' and size_bytes 0 while a browser recording is still being made
transcripts      id, recording_id, provider, model, language, raw_json, created_at,
                 status (pending|done|failed), provider_job_id (nullable), is_comparison (bool),
                 claimed_at, claim_token, claim_expires_at, poll_deadline_at, raw_path
                 -- one non-comparison row per recording; (install_id, provider, provider_job_id) unique
                 -- raw_path: the provider's raw result in storage; raw_json is no longer written
recap_outbox     transcript_id, install_id, meeting_id, created_at, sent_at   -- the recap job a transcript owes
recap_jobs_seen  transcript_id, install_id, seen_at       -- one recap job taken per transcript
segments         id, transcript_id, speaker_id, start_ms, end_ms, text
speakers         id, meeting_id, label, user_id (nullable), speaker_index (nullable)
                 -- a label can link to a directory user; one row per provider speaker number per meeting
recaps           id, meeting_id, template_id, body_md, current_version_id, docx_path,
                 status (drafting|ready|failed), failure_reason, draft_token
                 -- draft_token: the AI draft being written now; a draft that no longer holds it writes nothing
recap_versions   id, recap_id, number, author_id (null = AI), body_md, note, created_at   -- one per save
                 -- (recap_id, number) unique: a save on a stale base cannot land
decisions        id, recap_id, position, text, owner_user_id, done, due_on   -- the recap's decisions block, one row per item
                 -- due_on: a calendar date (YYYY-MM-DD), no time and no zone; null when none was set
recap_images     id, install_id, meeting_id, path, created_at   -- every uploaded recap image, for delete and retention
templates        id, name, name_key (unique), body_md, is_default   -- admin edits
keyterms         id, term, boost                               -- one list per install
settings         product_name, company_name, theme_accent, theme_primary, identity_provider,
                 oidc_tenant_id, oidc_client_id, oidc_client_secret (sealed), stt_provider,
                 stt_api_key (sealed), stt_region, webhook_secret (sealed), ai_gateway_id,
                 recap_provider (workers-ai|anthropic|openai|azure-openai), recap_model, recap_api_key (sealed),
                 language, interface_language, live_transcript_default,
                 default_visibility, retention_audio_days, retention_transcript_days, mcp_enabled,
                 recording_sources (JSON array of desktop|upload|browser|teams|meet),
                 admin_emails (JSON array), admin_bootstrap_claimed_at,
                 webhook_auto_send (off|company|shared), time_zone (IANA name)
audit_events     id, user_id, meeting_id, meeting_title, action (opened|exported|shared|visibility_changed|deleted|mcp_read|mcp_write
                 |recorder_connected|recorder_disconnected|webhook_sent|api_token_created|api_token_revoked),
                 details (JSON: before and after for shared and visibility_changed; the device name for the recorder actions;
                 the format, and `via` and the endpoint for a webhook's fetch; the endpoint and event for webhook_sent;
                 `via: api` and the token's name for a call with an API token; the name and scope for the API token actions), at
                 -- meeting_title is the title when the row was written; the row outlives the meeting
webhook_endpoints   id, install_id, label, url, secret (sealed), events (JSON array), enabled, created_at
webhook_deliveries  id, install_id, endpoint_id, event, meeting_id (no foreign key: the log outlives the meeting),
                    payload (JSON: the event and the meeting's metadata when it was queued), attempts, next_attempt_at,
                    status (pending|sending|delivered|parked|cancelled), last_status_code, last_error, last_attempt_at,
                    dedupe_key, created_at
                    -- (install_id, endpoint_id, dedupe_key) unique: a transcript or a version is sent once per endpoint
recorder_tokens  id, install_id, user_id, kind (recorder|api), device_name, scope (read|read_write; api only), token_hash,
                 created_at, last_used_at, expires_at, revoked_at, rate_window_at, rate_count
                 -- token_hash: SHA-256 hex of the token, unique per install; the token itself is never stored
                 -- device_name: the recorder's device, or the API token's name; rate_*: the API's per-minute window
recorder_grants  install_id, challenge, user_id, device_name, status (approved|denied|redeemed), created_at,
                 expires_at, last_poll_at, token_id
                 -- one per challenge; written by Approve or Cancel on /connect, redeemed by the token poll
meeting_search   install_id, meeting_id, kind (title|segment|recap), ref, text   -- FTS5 index, kept in sync by the app
storage_cleanup  id, path, created_at, attempts   -- objects whose rows are gone, still to delete from storage
```

Rules:

- A sealed column holds AES-GCM ciphertext under the Worker secret `SETTINGS_KEY`, bound to its column as additional data. The settings page shows only whether it is set.
- Identity is the OIDC subject. An address belongs to one user row; a sign-in with that address and another subject is refused. The admin list names addresses and applies to the user row that owns each.
- The first sign-in on a fresh install becomes admin and sets `admin_bootstrap_claimed_at`; the claim never runs again, however empty the list becomes.
- A meeting can have several recordings; one is primary. The first confirmed recording becomes primary; the owner can move it to another confirmed one.
- `title_folded` is the title NFKC-normalised and lower-cased by the app, for search: SQLite folds ASCII only. Rows from before it existed are filled at start-up.
- `failure` holds a contract error code when status is `failed`: `hash_mismatch`, `size_mismatch` and `session_expired` mean the upload failed and the audio is gone; anything else is a transcription failure with the audio kept: `stt_failed`, `stt_too_long`, `stt_auth`, `stt_unavailable`, `stt_config`. `failure_reason` holds a fixed reason and the HTTP status (`unauthorised:401`), never the provider's own text.
- `webhook_secret` is generated on the first request that finds none and sealed like the other secrets. It is sent only to the provider, as its webhook auth header, and never shown or logged.
- A speaker's default label is `Speaker n` (n from 1), shown in the reader's language. A rename sets the label; a link sets `user_id`, and the colleague's name is shown. A second recording of the same meeting reuses the row for the same provider speaker number.
- A comparison transcript (`is_comparison`, written by `pnpm stt:compare`) is never shown, searched or exported by the app.
- Every query, join and mutation carries `install_id`, child rows and shares included. A row whose install differs from the Worker's is ignored, whatever it points at; a meeting that another install's rows depend on is not deleted or archived.
- Retention runs nightly. Audio past `retention_audio_days` is deleted unless the meeting has `keep`; transcripts, their speakers and recaps follow `retention_transcript_days` the same way. Both count from the meeting's `started_at`. The meeting page announces a deletion 7 days ahead with Keep. A meeting whose audio and transcript are both gone keeps its metadata row with `deleted_at` set and shows in its owner's library as "Deleted by retention" until the owner removes it.
- Audit rows: `opened` when a meeting page or its audio is served to someone other than the owner, at most one per user, meeting and hour; `shared` and `visibility_changed` with before and after; `deleted` on delete; `exported` on export; `mcp_read` and `mcp_write` from MCP; `recorder_connected` when a recorder receives its token and `recorder_disconnected` when one is disconnected, with no meeting; `api_token_created` and `api_token_revoked` likewise. A call with an API token writes `opened`, `exported`, `shared` and `visibility_changed` with `via: api` (see "API"). `webhook_sent` when an endpoint took a meeting event, and `exported` with `via: webhook` when an endpoint fetched a link; both carry the meeting's owner as the user, since there is no service identity, and the endpoint's label in `details`. Deleting a meeting keeps its audit rows, detached from it, with the title they were written with.
- Search covers titles, transcript segments and recap text, through the same permission scope as the library, and answers with a snippet per meeting.
- Admin queries never join `segments`, `recaps` or `recap_versions` for a private meeting. Admin sees title, owner, dates and the audit log.
- Only the owner changes visibility. Shared colleagues read; they do not re-share.

## Recap editor

Tiptap 3 core with the open React UI components (MIT), inside the Next.js app. Block list: headings, quote, note and warning callouts, lists, checklist, toggle, table of contents, table, divider, code, image. `/` at the start of a word opens the block menu. `@` searches colleagues and the meeting's speakers. Block handles in the gutter add and drag blocks. Markdown in and out; a toggle is `<details>`, a callout is a GitHub alert (`> [!NOTE]`). A version is saved after 1.5 s of quiet. The AI draft is version 1 with no author; every human save is a version with an author. No Tiptap Pro extensions.

- **Drafting.** After a transcript, the recap job drafts from the transcript ("Speaker: text" lines, a timestamp every minute), the meeting's template (else the install's default) and the keyterms, in the transcript's language, with a 4,000-token output cap, through the install's recap model. A transcript longer than the model's context is summarised in parts first, and the version note says so. The first task list in the draft becomes the decisions block; an `@Name` that is a speaker linked to a colleague becomes a mention of that colleague and the decision's owner. A failure leaves the recap `failed` with a fixed reason; the owner gets Try again. Regenerate draft writes a new AI version and never replaces a human one.
- **Decisions.** Each item of the decisions block shows its owner (the first person it mentions) and its due date under the text: "Anne Holm · Due 30 Oct", "Anne Holm" when it has none. The meeting's date is not shown there. The owner sets, changes and clears the due date from the item, "Add due date" when it has none; each change, like a tick, is a change to the document saved at once, undone and explained when the server refuses it. Readers see the date and cannot change it. The draft sets a due date when the transcript says one relative to the meeting ("på torsdag", "i morgen", "inden fredag klokken tolv", "next week", "by the 30th"), worked out from `started_at` on the install's time zone; when the phrase is ambiguous ("next Friday") or names a past day, the item gets none. Word export adds the due date to the item; the `decisions` rows carry it as `due_on`.
- **Saving.** Every save names its base version; a save whose base is no longer the current version is refused and the editor says "Changed elsewhere · Reload" with who saved and when. The editor keeps unsaved text in the browser (IndexedDB, by recap and base version) until the server confirms it. Only the owner edits; readers get a read-only view. Restore makes a new version from an old one.
- **Markdown extras.** A table of contents is `<!-- toc -->`, the decisions block a task list between `<!-- decisions -->` and `<!-- /decisions -->` whose item may end in a due date, `~` and the date as `YYYY-MM-DD` (`- [ ] Test the new shift [@Anne Holm](mtxt:user/<id>) ~2026-10-30`), a mention `[@Name](mtxt:user/<id>)` (or `mtxt:speaker/<id>`). Images live at `images/{install_id}/{meeting_id}/{image_id}.{ext}` and are served through `/api/v1/meetings/{id}/recap/images/{file}` after the permission check. Each upload is a `recap_images` row, written before the object, so delete and retention remove every image of a meeting, whether or not it has a transcript or a recap. No other HTML is rendered.
- **Export.** Markdown (the stored body) and Word (.docx, built from the same document), named from the title and the date. Anyone who may read the recap may export it; each export is an `exported` audit row with the format.

## MCP

Per user, OAuth with the company login. Every call is scoped to what that user may see. Tools in v1:

- `list_meetings`, `get_transcript`, `get_minutes`, `search`
- `save_minutes`, `set_visibility`, `share`

Each write is an audit row. There is no service identity in v1.

## Webhooks

An install can feed its meetings into a company's own systems (a CRM, a case system) by posting events to up to five endpoints. A payload carries metadata and signed links, never content: the consumer fetches the transcript and the recap through the links, and every fetch checks the permission state at that moment. There is still no service identity: a link is a one-hour grant for one meeting and one format, not an account.

- **Endpoints.** Label (optional, up to 40 characters, the name of the system: "Alex"), URL (https on port 443 only, at most 2,048 characters, no credentials), the events to send, enabled. The signing secret (`whsec_` and 32 random bytes, base64url) is made by the server and shown once, when the endpoint is added; it is sealed like the other secrets and never shown again. Deleting an endpoint deletes its delivery log.
- **Events.** `meeting.transcribed` (a transcript is done), `recap.drafted` (the AI wrote a version), `recap.saved` (a person saved or restored a version; debounced: each save moves the unsent delivery to one minute after itself, so a typing session is one event, built from the latest version when it goes), `meeting.shared` (access widened: private to shared or company, shared to company, or a reader added; and the meeting may be sent. Narrowing and a removed reader send nothing), `meeting.deleted` (the owner deleted a meeting the endpoint took an earlier event of, while the meeting may still be sent: never after the consent was taken back), and `webhook.test` from "Send test event".
- **Which meetings.** A meeting may be sent when it is not deleted and either its owner has given consent (`meetings.webhook_consent_at`) or "Send automatically" covers its visibility now: `company` covers company meetings, `all shared` covers company and shared ones. Private meetings are never sent automatically. Setting a meeting to private takes the consent back; the owner gives it again with the action.
- **Consent.** The owner's overflow menu on the meeting page has "Send to connected systems", or "Send to <label>" when every enabled endpoint with a label has the same one. It sets `webhook_consent_at` and sends the current state at once: `meeting.transcribed` when a transcript is done, and `recap.drafted` or `recap.saved` (by the current version's author) when the recap has a version. It shows only when the install has an enabled endpoint. A reader sees nothing.
- **Payload.** JSON: `{ event, sent_at, install: { product_name }, meeting: { id, title, started_at, duration_s, visibility, owner: { name, email } }, links: { transcript, recap_markdown, recap_docx }, expires_at }`. A link is null when there is nothing to fetch yet. `meeting.deleted` carries only `meeting: { id, deleted_at }`, with `links` and `expires_at` null: no title, no owner; `webhook.test` has `meeting`, `links` and `expires_at` null. The payload and the links are built at each attempt, so a retry carries fresh links and the current title.
- **Signature.** `X-Mtxt-Signature: t=<unix seconds>,v1=<hex>`, where hex is HMAC-SHA256 with the endpoint's secret over `<t>.<raw body>`. A consumer checks it in constant time and refuses a `t` more than 5 minutes old. `X-Mtxt-Event` names the event and `X-Mtxt-Delivery` the delivery id, the same on every attempt of one delivery, for the consumer's dedupe.
- **Links.** `GET /api/v1/export/{token}` (or HEAD), outside the session gate for that one shape only: one segment, in canonical form, refused at the Worker entry with any other method (405) or any body (400), before the app reads anything. The token is `v1.<meeting id>.<format>.<expiry>.<endpoint id>.<signature>`: HMAC-SHA256 under a key derived from `SETTINGS_KEY` over the rest, valid one hour, no database row. Formats: `transcript` (JSON: language, speakers, segments with start, end, speaker and text), `md` and `docx` (the recap, as the export button gives them). At fetch time the meeting must still be one that may be sent and the endpoint must still exist and be enabled; otherwise 404, and an expired token is 410. Each fetch is an `exported` audit row with the format, `via: webhook` and the endpoint's label.
- **Delivery.** One `webhook_deliveries` row per event and endpoint, sent by a `webhook` queue job: POST with a 10-second timeout, no redirect followed, the answer's status recorded and its body never read. A 2xx is delivered; anything else, a timeout or a refused address waits 1 min, 10 min, 1 h, 6 h, then 24 h: six attempts in all, the first and five retries, and the delivery is parked when the sixth fails. Retry now, on the delivery log, sends a pending or parked delivery at once. A delivery whose meeting may no longer be sent when its turn comes is cancelled, not sent. An event for a meeting that already has an unsent delivery of the same event to the same endpoint joins it. A delivered meeting event is a `webhook_sent` audit row, written in one batch with the delivered status, so neither lands without the other; for `meeting.deleted` the row names the owner kept at the delete, detached from the meeting.
- **Outbound addresses.** A request goes only to the configured URL, https on port 443. Immediately before every attempt its host is resolved again and refused when any answer is a private address (RFC 1918, loopback, link-local, carrier-grade NAT, unique local, multicast or unspecified), or when it has no answer; an answer with a TTL under 60 s is looked up once more at once and accepted only when that answer is public too and names the same addresses; a host named `localhost` or ending in `.internal`, `.local` or `.localhost` is refused outright. On Cloudflare this check is best effort: a Worker's fetch resolves the name again and cannot be pinned to the checked address, and a Worker has no route into the customer's private network anyway. The Docker edition's HTTP client must connect to the checked address.
- **Delivery log.** Per endpoint, the last 50 deliveries: time, event, meeting title, status, attempts, the last answer (an HTTP status or a fixed reason), the next attempt, and Retry now. Admins only. The nightly job removes finished deliveries over 30 days old and sends any pending delivery whose queue message was lost.

## Phases

1. **v0.1 library, for the author's own use** in the Primux Cloudflare account. Login, upload, browser recorder, one speech-to-text adapter plus Workers AI Whisper tested on the same recording, keyterms, diarization with renaming, recap editor with templates, docx export, private and shared, retention. Built as of 2026-10-23 and running at `app.mtxt.co`.
2. **v0.2 recorder.** Build the Tauri 2 recorder: capture, company login, the queued upload. Live transcript as the optional setting. Built for macOS as of 2026-10-23; the Windows recorder is next.
3. **v0.3.** MCP server, wrapping the REST API (personal API tokens and `/api/v1` built as of 2026-10-23, packet 16). OneDrive and Drive pickup. Next as of 2026-10-23, together with Workers AI Whisper in chunks, so that a recording over 25 MiB transcribes there too.
4. **Release.** README, a wrangler deploy that targets any Cloudflare account, a short post. Customers come after the author has used it for a while. As of 2026-10-23 the deploy tooling exists (`deploy/`); the post and the first customer wait.
