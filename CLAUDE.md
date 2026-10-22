# mtxt: agent setup

Read `README.md` and `docs/spec.md` first. Kristian's open-source company meeting transcription platform, built in the open by Primux.

## Rules

- **Public repo.** No client material ever: no client names, recordings, transcripts, keyterm lists, screenshots with client data, or internal URLs. Installs are described as "a manufacturing company" or "a tourism organisation", never by name. Client context lives in LifeOS and the client repos, not here.
- **Licence: PolyForm Noncommercial 1.0.0** for our code, like scene-loop. Dependencies must be MIT, Apache-2.0, BSD or ISC. No GPL, AGPL, MPL or other source-available code copied in; GPL tools may run as separate programs. Code lifted from MIT projects (the Vibe fork) keeps its MIT notice. Models carry their own licences: note each one in `NOTICE.md` with its attribution line (Parakeet TDT v3 is CC-BY-4.0, Whisper is MIT).
- **No Tiptap Pro.** The recap editor is `@tiptap/core` plus open extensions, rebuilt from the documented design. Tiptap's Notion-like template and Pro extensions are not allowed; they need a paid plan and a Pro licence.
- **Meetings only.** No dictation, no hotkeys, no text insertion. Settled 2026-10-22; do not reopen it in code.
- **The settings page is the whole admin surface.** If a setting is not in `docs/spec.md`, it does not exist. Add to the spec first, then to the code.
- **Private means private.** No code path lets an admin read a private meeting's segments or recap. Admin sees metadata and the audit log.

## Layout, once the build starts

- This repo is the library: Laravel app at the root, `docker/` for compose and images, `docs/` for the spec and decisions.
- The recorder is a Vibe fork in `primux-dk/mtxt-recorder`, not here. The upload contract in `docs/spec.md` is the boundary between them.
- Decisions go to `docs/decisions.md` with a date. Specs go to `docs/spec.md`. Neither is a changelog; git is.

## Working

- There is no PHP on agent-server. Run tests with `phptest` from this checkout; it uses the box's test image.
- Branch work on agent-server goes in a worktree under `/srv/work/mtxt-<name>`, never in `/srv/work/mtxt` itself.
- Deploys, merges and anything a client sees wait for Kristian's explicit go, per action.
