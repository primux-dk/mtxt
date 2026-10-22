# Decisions

Dated, with the reason. Newest at the bottom. The spec in `spec.md` states the result; this file says why.

## 2026-10-22, the day the spec was settled

- **Meetings only, no dictation.** Dictation needs sub-second local models and OS-level text insertion, a different product with different constraints. Wispr Flow, TypeWhisper and Monologue exist for it.
- **Own build, not Speakr.** Speakr (AGPL-3.0) has most of the server features, but its surface is a homelab tool: a 0.x alpha, a dense UI, one maintainer. An IT department reads that as vendor risk. The enterprise layer, a calm UI, an admin surface IT can sign off, a version 1.0 with a company behind it, is the product.
- **Not TypeWhisper as the foundation.** A personal dictation app, GPL-3.0, one user per machine, no server. Worth taking: knowledge of local engines and the keyterm idea. Not code.
- **Licence: PolyForm Noncommercial 1.0.0**, the same as scene-loop. Changed from MIT the same day. Free to read, run and change for noncommercial use; a company running it in its business licenses it from Primux, which is the business model. Source-available rather than open source. Dependencies stay permissive (MIT, Apache-2.0, BSD, ISC); no GPL, AGPL or MPL copied in.
- **Docker, installs anywhere.** The first installs are a Microsoft house with Azure and a Dropbox house with no Azure. Not Azure-only.
- **Desktop recorder is capture route 1.** Pulling Teams or Meet recordings only works for meetings the company organised. A participant in someone else's meeting gets nothing. The recorder is our own Tauri 2 and Rust app. Vibe (MIT, about 27k lines of Rust), anarlog (MIT core, about 318k lines) and Meetily (MIT) are references for system audio capture and local models, not code we copy; the licence of this repo is not MIT, and a clean codebase is easier to license commercially than a fork. Changed from "fork Vibe" the same day.
- **Library stack: Laravel and Livewire.** The author's fastest stack. Queues plus provider adapters are the whole backend. The recap editor sits in a `wire:ignore` island.
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
