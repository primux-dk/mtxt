# mtxt: agent setup

Read `README.md` and `docs/spec.md` first. Kristian's source-available company meeting transcription platform, built in the open by Primux.

## Rules

- **Public repo.** No client material ever: no client names, recordings, transcripts, keyterm lists, screenshots with client data, or internal URLs. Installs are described as "a manufacturing company" or "a tourism organisation", never by name. Client context lives in LifeOS and the client repos, not here.
- **Licence: PolyForm Noncommercial 1.0.0** for our code, like scene-loop. Dependencies must be MIT, Apache-2.0, BSD or ISC. No GPL, AGPL, MPL or other source-available code copied in; GPL tools may run as separate programs. Models carry their own licences: note each one in `NOTICE.md` with its attribution line (Parakeet TDT v3 is CC-BY-4.0, Whisper is MIT).
- **No Tiptap Pro.** The recap editor is `@tiptap/core` plus open extensions, rebuilt from the documented design. Tiptap's Notion-like template and Pro extensions are not allowed; they need a paid plan and a Pro licence.
- **Meetings only.** No dictation, no hotkeys, no text insertion. Settled 2026-10-22; do not reopen it in code.
- **The settings page is the whole admin surface.** If a setting is not in `docs/spec.md`, it does not exist. Add to the spec first, then to the code.
- **Behaviour before polish.** `docs/design/behaviour.md` applies Kristian's 13 design traps to mtxt (autosave, optimistic updates with rollback, archive vs delete, URL state, three empty states, errors with a next step, keyboard and focus, reduced motion, hard fixture data). A screen's packet is done when its rules hold on the running app, with the checks listed there. `docs/design/README.md` and `tokens.css` hold the look.
- **Private means private.** No code path lets an admin read a private meeting's segments or recap. Admin sees metadata and the audit log.

## Layout, once the build starts

One repo for both halves, the anarlog way, so a change to the recorder-to-server contract lands in one commit.

```
apps/web/           Next.js and shadcn/ui library, deployed to Cloudflare Workers with OpenNext
apps/recorder/      Tauri 2 recorder, our own code
packages/contract/  the recorder-to-server contract: OpenAPI file plus generated TypeScript types
packages/adapters/  storage (R2 or S3), queue (Cloudflare Queues or database-backed), database (D1 or SQLite/Postgres)
docker/             the Docker edition, when it exists
docs/               spec and decisions
```

- pnpm workspace at the root for the JavaScript packages; Cargo under `apps/recorder`. Nothing at the root runs application code.
- **Every install runs in the owning company's own Cloudflare account.** Primux deploys with wrangler and holds no customer data. There is no multi-tenant service and no Primux-hosted edition. Code must never assume a shared account, a shared database or a Primux-owned bucket.
- **Cloudflare is the primary target, not the only one.** Nothing in `apps/web` imports an R2, Queues or D1 binding directly; it goes through `packages/adapters`, so a Docker edition can bind S3, a database queue and Postgres later.
- **The recorder is written by us.** Vibe, anarlog and Meetily are read for how they capture system audio and run local models; no file is copied from them. Crates they depend on (cpal, whisper-rs, ONNX runtime bindings) are ordinary dependencies under their own permissive licences, listed in `NOTICE.md`.
- `packages/contract` is the only thing both apps import. The server never reads recorder code and the recorder never reads server code.
- Decisions go to `docs/decisions.md` with a date. Specs go to `docs/spec.md`. Neither is a changelog; git is.

## Who does what

Kristian's setup for this project, 2026-10-22: a **Fable 5.1 (1M, high)** thread leads the work in this BB project: scoping, architecture, reviews of delegated work, anything irreversible. **Opus 5.5 (1M, high)** threads implement from a packet. **Codex (gpt-6.1-sol)** threads review: every implementation packet gets a Codex review before the lead accepts it. The lead does not implement multi-file changes itself. The lead archives a child thread (`bb thread archive <id>`) as soon as its work is accepted or discarded, so the project's thread list only shows live work.

## Working

- Node 22 and pnpm are on agent-server; wrangler runs locally with `wrangler dev`. Deploys to any Cloudflare account wait for Kristian's go.
- Branch work on agent-server goes in a worktree under `/srv/work/mtxt-<name>`, never in `/srv/work/mtxt` itself.
- Deploys, merges and anything a client sees wait for Kristian's explicit go, per action.
