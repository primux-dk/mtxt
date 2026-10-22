# Decisions

Dated, with the reason. Newest at the bottom. The spec in `spec.md` states the result; this file says why.

## 2026-10-22, the day the spec was settled

- **Meetings only, no dictation.** Dictation needs sub-second local models and OS-level text insertion, a different product with different constraints. Wispr Flow, TypeWhisper and Monologue exist for it.
- **Own build, not Speakr.** Speakr (AGPL-3.0) has most of the server features, but its surface is a homelab tool: a 0.x alpha, a dense UI, one maintainer. An IT department reads that as vendor risk. The enterprise layer, a calm UI, an admin surface IT can sign off, a version 1.0 with a company behind it, is the product.
- **Not TypeWhisper as the foundation.** A personal dictation app, GPL-3.0, one user per machine, no server. Worth taking: knowledge of local engines and the keyterm idea. Not code.
- **Licence: PolyForm Noncommercial 1.0.0**, the same as scene-loop. Changed from MIT the same day. Free to read, run and change for noncommercial use; a company running it in its business licenses it from Primux, which is the business model. Source-available rather than open source. Dependencies stay permissive (MIT, Apache-2.0, BSD, ISC); no GPL, AGPL or MPL copied in.
- **Docker, installs anywhere.** The first installs are a Microsoft house with Azure and a Dropbox house with no Azure. Not Azure-only.
- **Desktop recorder is capture route 1.** Pulling Teams or Meet recordings only works for meetings the company organised. A participant in someone else's meeting gets nothing. The recorder is our own Tauri 2 and Rust app. Vibe (MIT, about 27k lines of Rust), anarlog (MIT core, about 318k lines) and Meetily (MIT) are references for system audio capture and local models, not code we copy; the licence of this repo is not MIT, and a clean codebase is easier to license commercially than a fork. Changed from "fork Vibe" the same day.
- **Library stack: Laravel and Livewire.** The author's fastest stack. Queues plus provider adapters are the whole backend. Superseded the same evening, below.
- **Public repo from day one.** Licence and history clean from the first commit. No announcement before the second install runs.
- **Local models download from Hugging Face directly.** Zero work; revisit if an install's network blocks it.
- **Audio is sent after the meeting, chunked and resumable.** A 2-hour meeting is 100 MB or more on hotel wifi. The live transcript is local, so nothing needs the server during the meeting.
- **The laptop keeps its copy for 7 days after a confirmed upload.** The author lost recordings to a notetaker that deleted after a failed upload, more than once. Confirm means whole file plus hash match.
- **Warn after 24 hours without a confirm, keep retrying 7 days.** Covers a weekend offline.
- **Several recordings per meeting, one primary.** A voice recorder plus a laptop, or two colleagues recording, is the common case.
- **Speakers are free labels that can link to a directory user.** The same colleague is the same person across meetings; externals stay plain labels.
- **An admin never reads a private meeting.** Metadata and audit only. Private means private; retention still deletes it.
- **Only the owner changes visibility.** Shared colleagues read, they do not re-share.
- **Retention is per install with a keep flag per meeting.** Board minutes stay, the weekly standup goes.
- **Several recap templates per install, admin edits, user picks.** Board minutes, team decisions and an interview summary are three shapes at one small organisation alone.
- **The recap is an editable document inside the platform.** Notion-style Tiptap editor, rebuilt on Tiptap core and open extensions from a design the author already shipped elsewhere. Tiptap's own Notion-like template needs a paid plan in production and a Pro licence, so it cannot be redistributed in this repo.
- **MCP per user only, OAuth with the company login.** No service identity in v1. Read tools plus write tools (save minutes, set visibility, share), each write an audit row.
- **Live transcript in a small floating window, always on top, preview only.** One transcript per recording, made with keyterms and diarization on the server. No two versions to reconcile.
- **Browser recorder and file upload in v0.1, phone app later.** A browser recorder is a week; a phone app is a quarter.
- **Name: mtxt.** "Meeting text." The product name employees see is a setting per install.
- **First install's provider: AssemblyAI EU endpoint with their DPA.** ElevenLabs Scribe was the first choice for Danish quality, but on a self-serve plan EU residency and zero retention are Enterprise-only, and audio sits in US request history. A local model is tested alongside on the same recording.
- **Repo: primux-dk/mtxt.** Primux is the company the About page names.
- **One repo for recorder and library**, laid out like anarlog: `apps/server`, `apps/recorder`, `packages/contract`. The upload contract is the seam, and one repo lets a contract change land in both halves in one commit. A separate recorder repo was the earlier plan and is dropped.

## 2026-10-22, evening: the stack and who runs it

- **Next.js and shadcn/ui on Cloudflare Workers, not Laravel.** The product should be sellable, and Cloudflare's primitives fit it: R2 for audio with no egress fees, Queues, Durable Objects for resumable uploads, D1, Workers AI with Whisper, AI Gateway in front of the recap model, and a remote MCP server with OAuth from the agents SDK. Tiptap's open React components make the recap editor an assembly job. Storage, queue and database go behind adapters so a Docker edition stays possible; it is not built in v0.1.
- **Every install runs in the owning company's own Cloudflare account.** Primux does not host, not even a VPS per customer. Primux deploys with wrangler and holds no customer data. This is what makes the licence and the sale simple: the customer owns the account, the data and the bill.
- **The author's own install comes first.** Built for Primux's own meetings, used for a while, then offered to customers if it holds up. No customer deadline anchors the build.
- **Speech-to-text providers stay adapters.** AssemblyAI with an EU endpoint, Azure Speech, ElevenLabs Scribe, Workers AI Whisper. The company's own contract decides. ElevenLabs on a self-serve plan processes in the US with retention; EU residency and zero retention there are Enterprise-only, checked 2026-10-22.
- **Domains.** `mtxt.co` is the marketing site, `app.mtxt.co` the author's own install. Customers run on hostnames in their own zones.
- **EU processing is stated, not promised.** R2 and Durable Objects pin data to the EU on any plan; Worker placement and D1 location do not, and Cloudflare's Data Localization Suite is Enterprise-only. The admin's data-flow page says exactly that. Checked 2026-10-22.
- **AI Gateway fronts what it supports.** ElevenLabs, Deepgram, Workers AI and the recap model go through it; AssemblyAI is not a supported provider and is called directly. Checked 2026-10-22.
- **English interface at source, Danish as a translation.** Every string is written in English and translated through locale files; Danish is the first translation and the author's own install runs in Danish. An install outside Denmark gets a first-class interface, and Danish stays one translation among others instead of the source that everything else is derived from. Transcription language is a separate setting and stays Danish first. Kristian's call, 2026-10-22, during the design review; the first mockups were written in Danish and are redone in English.
- **Recap and transcript are tabs on the meeting page**, not two columns. Two columns squeezed the transcript to half the width and gave the recap editor no room; one panel at a time at the full content width reads better on every screen size and is the same layout on a phone. Kristian, 2026-10-22, from the first mockup.
- **Installs may tweak two colours.** Accent and button colour, with everything else derived and contrast enforced. A company that runs the app under its own product name wants it to look like its own, and two values cover that without a theme editor. Design guidelines live in the repo as HTML and are served by the app at `/design` from the live tokens, so the reference and the install never drift apart. Kristian, 2026-10-22.

## 2026-10-22, v0.1 packet 1: the scaffold

- **`meetings.archived_at` joins the data model.** Behaviour rule 3 separates archive (out of the library views, restorable) from delete (permanent). A nullable timestamp is the smallest way to hold it; `deleted_at` stays for the delete path.
- **Every row's `install_id` comes from the Worker variable `INSTALL_ID`.** One install per account, so the value is fixed per deploy, set in `wrangler.jsonc` vars, and written by the seed. Local development uses `dev`.
- **First migration is `0000_init.sql`.** drizzle-kit numbers from 0000 and tracks the names in its journal; renaming it would make the next generated migration collide. Wrangler applies the folder in name order and does not care where numbering starts.
- **The default transcription language seeds as `auto`.** The packet's seed list did not name one, and `auto` works for an install outside Denmark too. An admin sets `da` in settings.
- **Locale keys that are both a string and a prefix move to `.text`.** next-intl reads dots as nesting, so `meeting.keep` and `meeting.keep.label` cannot both be strings. `meeting.keep`, `recorder.mic` and `recorder.system` became `meeting.keep.text`, `recorder.mic.text` and `recorder.system.text` in `apps/web/messages`. The mockups' flat files keep their keys.
- **No locale prefix in URLs.** The interface language follows `Accept-Language` when a translation exists, else the install default, per the spec. A link then opens in the reader's own language, and the library's URL state stays clean.
- **Mona Sans loads through `tokens.css`'s own `@font-face`.** `globals.css` imports `tokens.css`, and the build bundles the font it points to. One file, no second copy, no `next/font` wrapper.
- **`/design` lives at `/design/`.** The guidelines link to `tokens.css`, `mockups/` and `locales/` relatively, so the page is served with a trailing slash; `/design` redirects there. The files are bundled into the Worker at build time, not copied into `public/`, so the signed-in check in packet 2 covers them all.
- **The app applies the install's two theme values on every page,** not only on `/design`, as a `html:root` style from the settings row. The spec says every colour derives from them.
- **Dark mode follows the operating system.** The design's preview switch is a review tool; the app sets `.dark` from `prefers-color-scheme`.
- **TypeScript 5.9, ESLint 9, Next.js 15 on webpack.** `eslint-config-next` 15 declares ESLint 7 to 9, so ESLint 10 is out. TypeScript 7 is the new native compiler; staying on 5.9 keeps Next.js 15's type check and typescript-eslint on the version they are built against. Webpack (Next.js 15's default) gives the `?raw` imports `/design` needs.
- **The package build script is `next build`; the Worker build is `build:cf`.** OpenNext runs the package's own `build` script, so naming the OpenNext command `build` recursed.
- **shadcn/ui on the Radix base, `radix-nova` style, restyled to the tokens.** The CLI installs its components with the `cn` helper package (MIT, from the shadcn project) instead of clsx and tailwind-merge.
- **The e2e test runs on `wrangler dev`,** on the OpenNext build, with local D1, R2, Queues and the Durable Object. The build takes about 1.5 minutes, which CI makes anyway; `next dev` would test a different runtime.
- **Licence check: runtime dependencies only, exceptions by package name.** `pnpm check:licenses` fails on a runtime dependency outside MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, CC0, Unlicense, Python-2.0 and OFL-1.1. `caniuse-lite` (CC-BY-4.0, data) and six BlueOak-1.0.0 packages (glob and its family, build tooling under Next.js and OpenNext) are named in `scripts/license-exceptions.json` for the lead to confirm, rather than widening the allowed list. Dev-only tools outside the list (lightningcss and axe-core under MPL-2.0, sharp's libvips under LGPL-3.0) run as separate programs at build time and are not shipped.
