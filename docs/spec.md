# mtxt specification

Settled 2026-10-22. Changes go here first, then into code. Decisions and their reasons are in `decisions.md`.

## What it is

One web app that runs in the company's own Cloudflare account, plus a small recorder on each employee's machine. Every meeting becomes a transcript and an editable recap in the company's own library, private or shared inside the company, and open to the company's AI tools through MCP. Meetings only: no dictation.

The product name an employee sees is a setting per install ("Acme Meetings"). mtxt appears only in About and on GitHub.

The interface is written in English and translated. English is the source of every string, in the library and in the recorder; Danish is the first translation. A user gets the interface in the browser's or operating system's language when a translation exists, otherwise in the install's default interface language. Interface language and transcription language are separate settings.

## Scope: 10 features

| # | Feature | What it means |
|---|---|---|
| 1 | Company login | OIDC against Entra ID or Google Workspace. No local users, no passwords. |
| 2 | Desktop recorder | Mic plus system audio on Mac and Windows, bot-free. Signed in with the company login, uploads when the meeting ends. Our own Tauri 2 and Rust app, with Vibe, anarlog and Meetily as references. |
| 3 | Live transcript | Text on screen while the meeting runs, in a small floating window, always on top. A per-user setting with an admin default, off by default. Runs a local model in the recorder. A preview only; the server transcript is the record. |
| 4 | Other capture | Record in the browser, upload a file, share from a voice recorder. Pull Teams and Meet recordings for meetings the company organised. |
| 5 | STT adapter | AssemblyAI, Azure Speech, ElevenLabs Scribe, local Whisper or Parakeet. One per install, swappable. |
| 6 | Keyterms and corrections | One company dictionary per install: product names, people, jargon. CSV import. Danish first. |
| 7 | Speakers | Diarization, renaming, voice memory per install where the provider allows it. Labels can link to a directory user. |
| 8 | Recap | AI drafts from the chosen template; the owner edits in a Notion-style Tiptap editor inside the platform. Markdown stored, a version per save, AI text and human edits told apart. Export md and docx. Search across what you may see. |
| 9 | Private and shared | Each meeting is private, shared with named colleagues, or company-wide. Admin sets the default. Only the owner changes it. Search and MCP respect it. |
| 10 | Retention, audit, MCP | Delete after N days per install, with a keep flag per meeting. A log of who opened what. MCP server with the same company login, scoped to what the user may see. |

Not in scope: dictation of any kind, hotkeys, push-to-talk; a bot that joins calls; snippets, user-selectable themes beyond the install's two colours, a plugin marketplace, a premium tier, widgets, per-user LLM settings.

## Capture routes, in build order

1. **Desktop recorder.** The only route that covers a meeting someone else organised. Our own code: Core Audio process tap on Mac, WASAPI loopback on Windows, whisper.cpp and Parakeet for the live preview, the way Vibe, anarlog and Meetily do it.
2. **Browser and upload.** A recorder in the browser and file upload, in v0.1. A phone app later.
3. **Pull platform recordings.** Teams recordings through Microsoft Graph (`getAllRecordings`, application permission `OnlineMeetingRecording.Read.All`, admin consent plus an application access policy; organiser's recordings only). Meet recordings through the Meet REST API and a Drive download. Only for meetings the company organised.
4. **Meeting bot.** Avoided. Visible, brittle, per-minute cost.

## Settings page

The whole admin surface. If a setting is not here, it does not exist.

| Setting | Values |
|---|---|
| Product name | Free text, shown on the recorder, the login page and the tray |
| Theme | Accent colour and button colour, two hex values. Defaults are sage #566b45 and #111111. Tints, lines, focus ring and the dark mode are derived. Three pairs are checked in both themes, accent text on the background, button text on the button, accent on a card; a value that puts any pair under 4.5:1 is refused with the ratio shown. A preview row under the fields shows the derived states. The recorder reads the same two values at login |
| Identity provider | Entra ID or Google: tenant id, client id, secret |
| Speech-to-text provider | AssemblyAI (EU), Azure Speech (region), ElevenLabs Scribe, local Whisper or Parakeet: key, region |
| Interface language | Default for the install: en or da. A user's browser or OS language wins when a translation exists |
| Default language | For transcription. ISO code, auto-detect allowed |
| Keyterms | One list per install, CSV import |
| Live transcript | On by default: yes or no. Users can switch it for themselves |
| Default visibility | private, shared, company |
| Recording sources | Desktop, upload, browser, OneDrive (Teams), Drive (Meet) |
| Recap templates | Several per install, markdown, admin edits, user picks per meeting |
| Retention | Audio N days, transcripts and recaps N days |
| MCP server | Enabled: yes or no |

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

"Confirmed" means the platform holds the whole file and its hash matches. Only then does the recorder's 7-day local timer start. Without a confirm the recorder keeps the file and retries; it warns the user after 24 hours and asks the user after 7 days.

Recorder states per recording: Recording, Uploading, Pending (no network), Warn (24 h), AskUser (7 d), Confirmed, Deleted (7 d after confirm).

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
- Domains: `mtxt.co` is the marketing site, `app.mtxt.co` is the author's own install. A customer's install runs on a hostname in the customer's own zone (for example `meetings.customer.com`), in the customer's own account.
- EU data, checked 2026-10-22 against Cloudflare's data-localization docs: audio at rest is pinned with R2 jurisdictional restrictions (EU), upload sessions with Durable Object jurisdiction `eu`, both available without an Enterprise plan. D1 has no jurisdiction setting today. Where Worker code runs is best effort (the nearest data centre to the request) unless the customer has the Data Localization Suite, an Enterprise-only add-on. Workers AI and AI Gateway are not covered by Regional Services. State this plainly in the admin's data-flow page; do not promise EU-only processing.
- AI Gateway, checked 2026-10-22: proxies ElevenLabs, Deepgram, Workers AI, OpenAI, Azure OpenAI, Anthropic, Google, Mistral and others. AssemblyAI is not a supported provider, so that adapter calls AssemblyAI directly; the gateway fronts the recap model and the providers it supports.

## Data model

One database per install, in the company's own account. Every row carries an install id for safety; v1 runs one company per install and no code assumes otherwise.

```
users            id, oidc_subject, email, name, is_admin
meetings         id, owner_id, title, started_at, visibility (private|shared|company),
                 keep (bool), template_id, archived_at, deleted_at   -- archived: out of the views, restorable
meeting_shares   meeting_id, user_id                       -- "shared" visibility only
recordings       id, meeting_id, uploaded_by, source (desktop|browser|upload|teams|meet|device),
                 is_primary, duration_s, sha256, size_bytes, storage_path,
                 status (uploading|confirmed|transcribing|transcribed|failed), delete_audio_at
transcripts      id, recording_id, provider, model, language, raw_json, created_at
segments         id, transcript_id, speaker_id, start_ms, end_ms, text
speakers         id, meeting_id, label, user_id (nullable)  -- a label can link to a directory user
recaps           id, meeting_id, template_id, body_md, current_version_id, docx_path
recap_versions   id, recap_id, author_id (null = AI), body_md, created_at   -- one per save
decisions        id, recap_id, text, owner_user_id, done     -- lifted from the recap by the AI, editable
templates        id, name, body_md, is_default                 -- admin edits
keyterms         id, term, boost                               -- one list per install
settings         product_name, theme_accent, theme_primary, identity_provider, stt_provider, language, interface_language, live_transcript_default,
                 default_visibility, retention_audio_days, retention_transcript_days, mcp_enabled
audit_events     id, user_id, meeting_id, action (opened|exported|shared|visibility_changed|deleted|mcp_read|mcp_write), at
```

Rules:

- A meeting can have several recordings; one is primary.
- Retention runs nightly. Audio past `retention_audio_days` is deleted unless the meeting has `keep`; transcripts and recaps follow `retention_transcript_days` the same way.
- Admin queries never join `segments`, `recaps` or `recap_versions` for a private meeting. Admin sees title, owner, dates and the audit log.
- Only the owner changes visibility. Shared colleagues read; they do not re-share.

## Recap editor

Tiptap 3 core with the open React UI components (MIT), inside the Next.js app. Block list: headings, quote, note and warning callouts, lists, checklist, toggle, table of contents, table, divider, code, image. `/` at the start of a word opens the block menu. `@` searches colleagues and the meeting's speakers. Block handles in the gutter add and drag blocks. Markdown in and out; a toggle is `<details>`, a callout is a GitHub alert (`> [!NOTE]`). A version is saved after 1.5 s of quiet. The AI draft is version 1 with no author; every human save is a version with an author. No Tiptap Pro extensions.

## MCP

Per user, OAuth with the company login. Every call is scoped to what that user may see. Tools in v1:

- `list_meetings`, `get_transcript`, `get_minutes`, `search`
- `save_minutes`, `set_visibility`, `share`

Each write is an audit row. There is no service identity in v1.

## Phases

1. **v0.1 library, for the author's own use** in the Primux Cloudflare account. Login, upload, browser recorder, one speech-to-text adapter plus Workers AI Whisper tested on the same recording, keyterms, diarization with renaming, recap editor with templates, docx export, private and shared, retention.
2. **v0.2 recorder.** Build the Tauri 2 recorder: capture, company login, the queued upload. Live transcript as the optional setting.
3. **v0.3.** MCP server. OneDrive and Drive pickup.
4. **Release.** README, a wrangler deploy that targets any Cloudflare account, a short post. Customers come after the author has used it for a while.
