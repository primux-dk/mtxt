# mtxt Recorder

The desktop recorder: microphone and system audio from a meeting, recorded to one file on the Mac, queued and uploaded to the company's own library. A local model can show a live transcript while the meeting runs; that text is a preview and never leaves the Mac. macOS 14.2 and later in this version; Windows comes later.

The app calls itself by the install's product name ("Primux Møder") once it is connected. The bundle is "mtxt Recorder", bundle id `co.mtxt.recorder`; mtxt appears in About.

## Build

Prerequisites: Rust (rustup, both macOS targets for a universal build), Node 22 and pnpm (from the repository root), Xcode command line tools, CMake (`brew install cmake`, for libopus and whisper.cpp).

```sh
pnpm install                                    # at the repository root
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm recorder:dev                               # the app with the Vite dev server
pnpm recorder:build                             # universal .app and .dmg
```

The build lands in `src-tauri/target/universal-apple-darwin/release/bundle/` (`macos/mtxt Recorder.app`, `dmg/mtxt Recorder_<version>_universal.dmg`). `tauri.conf.json` signs ad hoc (`signingIdentity: "-"`). To sign with a Developer ID, set `APPLE_SIGNING_IDENTITY="Developer ID Application: …"` for the build; notarisation needs `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` and is not set up yet.

The universal binary has Parakeet in the Apple silicon slice only: ONNX Runtime publishes no prebuilt library for Intel Macs. Whisper runs on both.

Tests:

```sh
cd apps/recorder/src-tauri && cargo test        # state machine, chunks, hashing, backoff, resampler,
                                                # Ogg Opus, connect, locale; the contract test; the mock server
pnpm --filter @mtxt/recorder test               # theme maths against tokens.css, locale files
node apps/recorder/scripts/check-crate-licenses.mjs   # also run by pnpm check:licenses
```

`examples/manual_run.rs` runs the whole path against an install without the window: connect through the browser, record (`--capture 60`) or encode a WAV (`--wav`), upload, poll to `transcribed`, disconnect. `examples/capture_probe.rs` records a few seconds and prints the levels; `examples/live_probe.rs` runs a local model on a WAV.

`preview/` renders the real window pages in a browser from fixture snapshots, for screenshots and design review: run `pnpm --filter @mtxt/recorder dev` and open `http://localhost:1420/preview/main.html?state=figure05&lang=da&theme=dark` (states are in `preview/fixtures.ts`) or `preview/live.html?live=listening`.

## How it works

- **Capture.** The microphone through cpal. System audio through a Core Audio process tap: a private, global stereo tap on every process but the recorder, read through a private aggregate device (`src/audio/macos_tap.rs`). Each source fills a lock-free ring; a mixer thread on the wall clock takes 20 ms frames, pads a source that is short, trims one that runs ahead, and writes stereo Opus in Ogg at 48 kbit/s: microphone left, system audio right. Pages reach the disk every second, whole pages at a time, so a crash leaves a file that plays to its last second; the next start lists it as an interrupted recording, which uploads after the user chooses Upload.
- **Ownership.** A recording belongs to the install and the user that were connected when it was made, and uploads only with that user's token to that install. Rows of another install or user wait, with Save elsewhere.
- **Upload.** Per docs/spec.md "How a recording reaches the library": `POST /recordings` with the meeting, `source: desktop`, the SHA-256 and the size; 8 MiB chunks to `PUT …/chunks/{n}`; `POST …/complete`. A resume asks `GET /recordings/{id}` for `chunks_received`. `busy` waits for `Retry-After`. Failures retry with backoff (2 s doubling to 5 minutes, ±20 %). The local states are Recording, Uploading, Pending, Warn (24 hours), AskUser (7 days), Confirmed, Deleted (7 days after the confirm); `src/queue/state.rs` holds the rules and their tests.
- **Connect.** Per docs/spec.md "Recorder connection": a PKCE verifier, the `/connect` page in the default browser, the pairing code on both sides, a poll of `POST /recorder/token`. The token goes to the Keychain; the rest of the token response (product name, theme colours, user name, interface language, live transcript default) to `settings.json`.
- **Live transcript.** Off unless the admin default or the user's switch turns it on. The mix, at 16 kHz mono, goes to Parakeet TDT 0.6B v3 through ONNX Runtime (`src/live/parakeet.rs`, one runtime environment per process) or Whisper large-v3-turbo through whisper.cpp (`src/live/whisper.rs`), cut at pauses (`src/live/segmenter.rs`). The live window lists every finished line of the running recording with its time (mm:ss from the recording's start), the line in progress muted under them; it follows new lines while the view is at the end and shows "Jump to latest" when the user has scrolled up. Arrows and Page keys scroll, End jumps to the latest. If the model cannot run, the window says why. The text lives in memory only and is dropped when the recording stops.
- **Look and strings.** The window CSS is the mockup's (figures 05 and 06) on `docs/design/tokens.css`; `src/theme.ts` derives the accent and button tokens from the install's two colours with the same oklab mixing tokens.css uses, and a test checks them against the defaults written there. Strings are in `locales/en.json` and `locales/da.json`; the interface follows the operating system's language when a translation exists, otherwise the install's default.

## The row menu

Each row of "Recent recordings" has a three-dot menu (keyboard: Enter or Arrow Down opens it, arrows move, Escape closes and returns focus to the dots):

- **Save audio to…**: a hash-checked copy, named "<title> <date>.ogg", whenever the audio is on this Mac. The entry does not change.
- **Open in library**: the meeting on the install, once the library has the recording.
- **Delete from this Mac**: the local copy only. A confirmed recording goes at once and shows "Uploaded · Removed from this Mac". One the library does not have yet asks by name first, because it is the only copy. Never offered while a recording records or uploads.

The row title stays a link to the meeting.

## Permissions

The first Record press explains the two permissions, then macOS asks:

- **Microphone**: System Settings → Privacy & Security → Microphone.
- **System audio**: macOS calls it audio recording (System Settings → Privacy & Security → Screen & System Audio Recording, "System Audio Recording Only"). Without it a process tap delivers silence, so the recorder asks before it opens one.

A denied permission shows in the window with a button to the right System Settings pane and "Check again". A recording runs with whichever source is allowed.

## Where files live

`~/Library/Application Support/co.mtxt.recorder/`:

- `recordings/<id>.ogg`, the audio, and `recordings/<id>.json`, its state (title, owner, install, start, duration, SHA-256, size, chunk progress, server ids, status, confirm time, device gaps). The state file stays after the audio is deleted, as the record of what happened. A state file that does not parse is listed as a damaged entry; after its audio is saved elsewhere it is kept as `<id>.json-damaged`. Audio without a state file is listed as a recovered recording.
- `settings.json`: the install's address and branding, the live transcript switch, the chosen model.
- `models/parakeet/`, `models/whisper/`: the local models, downloaded on first use from Hugging Face and checked against their SHA-256.

The token is in the login Keychain, service `co.mtxt.recorder`, account the install's address, stored with its token id; it is used only when that id is the one `settings.json` names.

## Reset

Quit the recorder, then:

```sh
rm -rf ~/Library/Application\ Support/co.mtxt.recorder          # queue, settings, models
security delete-generic-password -s co.mtxt.recorder             # the token, once per install
tccutil reset Microphone co.mtxt.recorder
tccutil reset AudioCapture co.mtxt.recorder
```

Deleting `recordings/` deletes recordings that may not be in the library yet. Look at the queue first.
