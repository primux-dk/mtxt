# mtxt Recorder

The desktop recorder: microphone and system audio from a meeting, recorded to one file on the computer, queued and uploaded to the company's own library. A local model can show a live transcript while the meeting runs; that text is a preview and never leaves the computer. macOS 14.2 and later, and Windows 10 and 11 (x64).

The app calls itself by the install's product name ("Primux Møder") once it is connected. The bundle is "mtxt Recorder", bundle id `co.mtxt.recorder`; mtxt appears in About.

## Build

### macOS

Prerequisites: Rust (rustup, both macOS targets for a universal build), Node 22 and pnpm (from the repository root), Xcode command line tools, CMake (`brew install cmake`, for libopus and whisper.cpp).

```sh
pnpm install                                    # at the repository root
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm recorder:dev                               # the app with the Vite dev server
pnpm recorder:build                             # universal .app and .dmg
```

The build lands in `src-tauri/target/universal-apple-darwin/release/bundle/` (`macos/mtxt Recorder.app`, `dmg/mtxt Recorder_<version>_universal.dmg`). `tauri.conf.json` signs ad hoc (`signingIdentity: "-"`). To sign with a Developer ID, set `APPLE_SIGNING_IDENTITY="Developer ID Application: …"` for the build; notarisation needs `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` and is not set up yet.

The universal binary has Parakeet in the Apple silicon slice only: ONNX Runtime publishes no prebuilt library for Intel Macs. Whisper runs on both.

### Windows

Prerequisites: Rust (rustup, the MSVC toolchain), Visual Studio Build Tools with "Desktop development with C++", CMake, LLVM (for whisper-rs's bindgen; set `LIBCLANG_PATH` to its `bin` folder), Node 22 and pnpm. WebView2 is part of Windows 10 and 11.

```sh
pnpm install                                    # at the repository root
pnpm recorder:build:windows                     # MSI and NSIS installer
```

The installers land in `src-tauri/target/release/bundle/` (`msi/mtxt Recorder_<version>_x64_en-US.msi`, `nsis/mtxt Recorder_<version>_x64-setup.exe`). The Recorder workflow (`.github/workflows/recorder.yml`) builds both on `windows-latest` and keeps them as the run's `mtxt-recorder-windows` artifact. Both models are in the Windows build; Whisper runs on the CPU there.

`tauri.conf.json` holds what both platforms share; `tauri.macos.conf.json` and `tauri.windows.conf.json` hold each platform's bundle settings, and Tauri merges the one for the platform it builds on.

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

- **Capture.** The microphone through cpal on both platforms (`src/audio/capture/mic.rs`). System audio on macOS through a Core Audio process tap: a private, global stereo tap on every process but the recorder, read through a private aggregate device (`src/audio/capture/macos.rs`). On Windows through WASAPI loopback on the default output device, polled every 10 ms, reopened when the default device changes or goes away, each packet placed by its QPC timestamp so the silence Windows leaves out becomes zeros at the right place (`src/audio/capture/windows.rs`, `loopback.rs`). Each source fills a lock-free ring; a mixer thread on the wall clock takes 20 ms frames, pads a source that is short, trims one that runs ahead, and writes stereo Opus in Ogg at 48 kbit/s: microphone left, system audio right. Pages reach the disk every second, whole pages at a time, so a crash leaves a file that plays to its last second; the next start lists it as an interrupted recording, which uploads after the user chooses Upload.
- **Ownership.** A recording belongs to the install and the user that were connected when it was made, and uploads only with that user's token to that install. Rows of another install or user wait, with Save elsewhere.
- **Upload.** Per docs/spec.md "How a recording reaches the library": `POST /recordings` with the meeting, `source: desktop`, the SHA-256 and the size; 8 MiB chunks to `PUT …/chunks/{n}`; `POST …/complete`. A resume asks `GET /recordings/{id}` for `chunks_received`. `busy` waits for `Retry-After`. Failures retry with backoff (2 s doubling to 5 minutes, ±20 %). The local states are Recording, Uploading, Pending, Warn (24 hours), AskUser (7 days), Confirmed, Deleted (7 days after the confirm); `src/queue/state.rs` holds the rules and their tests.
- **Connect.** Per docs/spec.md "Recorder connection": a PKCE verifier, the `/connect` page in the default browser, the pairing code on both sides, a poll of `POST /recorder/token`. The token goes to the Keychain (Credential Manager on Windows); the rest of the token response (product name, theme colours, user name, interface language, live transcript default) to `settings.json`.
- **Live transcript.** Off unless the admin default or the user's switch turns it on. The mix, at 16 kHz mono, goes to Parakeet TDT 0.6B v3 through ONNX Runtime (`src/live/parakeet.rs`, one runtime environment per process) or Whisper large-v3-turbo through whisper.cpp (`src/live/whisper.rs`), cut at pauses (`src/live/segmenter.rs`). The live window lists every finished line of the running recording with its time (mm:ss from the recording's start), the line in progress muted under them; it follows new lines while the view is at the end and shows "Jump to latest" when the user has scrolled up. Arrows and Page keys scroll, End jumps to the latest. If the model cannot run, the window says why. The text lives in memory only and is dropped when the recording stops.
- **Look and strings.** The window CSS is the mockup's (figures 05 and 06) on `docs/design/tokens.css`; `src/theme.ts` derives the accent and button tokens from the install's two colours with the same oklab mixing tokens.css uses, and a test checks them against the defaults written there. Strings are in `locales/en.json` and `locales/da.json`; the interface follows the operating system's language when a translation exists, otherwise the install's default. `locales/en.windows.json` and `locales/da.windows.json` hold the Windows wording of the messages that name the Mac or System Settings, read first on Windows.

## Checked on a Mac

`docs/screenshots/native/` holds the native evidence: real capture of the microphone and system audio, device switching during a recording, two recordings in a row with live text, the Keychain token after a reinstall, and the row menu, with the numbers measured in the files.

## The row menu

Each row of "Recent recordings" has a three-dot menu (keyboard: Enter or Arrow Down opens it, arrows move, Escape closes and returns focus to the dots):

- **Save audio to…**: a hash-checked copy, named "<title> <date>.ogg", whenever the finished audio is on this Mac (not while it records). The entry does not change.
- **Open in library**: the meeting on the install, once the library has the recording.
- **Delete from this Mac**: the local copy only. A confirmed recording goes at once and shows "Uploaded · Removed from this Mac". One the library does not have yet asks by name first, because it is the only copy. Never offered while a recording records or uploads.

The row title stays a link to the meeting.

## Permissions

### macOS

The first Record press explains the two permissions, then macOS asks:

- **Microphone**: System Settings → Privacy & Security → Microphone.
- **System audio**: macOS calls it audio recording (System Settings → Privacy & Security → Screen & System Audio Recording, "System Audio Recording Only"). Without it a process tap delivers silence, so the recorder asks before it opens one.

A denied permission shows in the window with a button to the right System Settings pane and "Check again". A recording runs with whichever source is allowed.

### Windows

Windows asks a desktop app nothing. The microphone follows Settings → Privacy & security → Microphone: "Let desktop apps access your microphone" on, and the device-wide switch an administrator can turn off. When one is off, the window says so with "Open Settings" and "Check again". System audio needs no permission: loopback hears whatever the default output device plays.

## Where files live

`~/Library/Application Support/co.mtxt.recorder/` on macOS, `%LOCALAPPDATA%\co.mtxt.recorder\` on Windows (the local, not the roaming, profile):

- `recordings/<id>.ogg`, the audio, and `recordings/<id>.json`, its state (title, owner, install, start, duration, SHA-256, size, chunk progress, server ids, status, confirm time, device gaps). The state file stays after the audio is deleted, as the record of what happened. A state file that does not parse is listed as a damaged entry; after its audio is saved elsewhere it is kept as `<id>.json-damaged`. Audio without a state file is listed as a recovered recording.
- `settings.json`: the install's address and branding, the live transcript switch, the chosen model.
- `models/parakeet/`, `models/whisper/`: the local models, downloaded on first use from Hugging Face and checked against their SHA-256.

- `logs\recorder.log` on Windows: the current run's log, with the run before it as `recorder.previous.log`. On macOS the log goes to stderr; run the app from Terminal (`"/Applications/mtxt Recorder.app/Contents/MacOS/mtxt-recorder"`) to see it.

The token is in the login Keychain on macOS, service `co.mtxt.recorder`, account the install's address; on Windows in Credential Manager (Control Panel → Credential Manager → Windows Credentials), named `<install address>.co.mtxt.recorder`. It is stored with its token id and used only when that id is the one `settings.json` names.

## Reset

Quit the recorder, then on macOS:

```sh
rm -rf ~/Library/Application\ Support/co.mtxt.recorder          # queue, settings, models
security delete-generic-password -s co.mtxt.recorder             # the token, once per install
tccutil reset Microphone co.mtxt.recorder
tccutil reset AudioCapture co.mtxt.recorder
```

On Windows, in PowerShell:

```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\co.mtxt.recorder"     # queue, settings, models, log
cmdkey /list | Select-String co.mtxt.recorder                  # the token entries; remove each with
cmdkey /delete:"<install address>.co.mtxt.recorder"
```

Deleting `recordings/` deletes recordings that may not be in the library yet. Look at the queue first.

## Installing on Windows

The installers are not signed yet. SmartScreen shows "Windows protected your PC" for the first runs of an unsigned download: choose More info, then Run anyway. A company that deploys the MSI through Intune or Group Policy does not see the prompt.

- **NSIS (`…-setup.exe`)**: installs for the current user, without administrator rights, under the user's `%LOCALAPPDATA%`, with a Start menu entry. Uninstall from Settings → Apps.
- **MSI**: installs for the machine, under `Program Files`, and needs administrator rights. A later MSI upgrades it in place (the upgrade code is fixed in `tauri.windows.conf.json`).
- There is no updater, as on macOS. A new version is a new installer.
- Recordings, settings and models stay under `%LOCALAPPDATA%\co.mtxt.recorder` through an uninstall and a reinstall, as on macOS, unless "Delete the application data" is ticked in the NSIS uninstaller. That box deletes recordings the library may not have yet.
- The recorder lives in the notification area. Windows 11 puts a new icon behind the "^" overflow; drag it onto the taskbar to keep it in view.

## Checking a Windows build

CI builds the installers and runs the Rust tests on `windows-latest`, which has no audio devices. What needs a real Windows machine, with what passes:

1. **Install.** Download `mtxt-recorder-windows` from the PR's Recorder run and run the NSIS installer as a normal user. Pass: SmartScreen offers Run anyway; the app installs without an administrator prompt and starts; the tile icon is in the notification area (or its overflow).
2. **Connect.** Enter the install's address and connect. Pass: the default browser opens `/connect`, the pairing code matches, Approve gives "Connected"; Credential Manager has `<address>.co.mtxt.recorder`; Recorders in the library lists the PC under its computer name.
3. **Microphone switch.** Turn off "Let desktop apps access your microphone", open the recorder window. Pass: "The microphone is not allowed" with Open Settings, which opens the Microphone privacy page; turning it back on and Check again clears it.
4. **A Teams call.** Join a Teams (or Meet in a browser) call with a second person, on the PC's speakers or a headset, start a recording, talk both ways for two minutes, stop. Pass: both meters move while each side talks; the recording uploads and reaches `transcribed`; in the library both voices are in the transcript; played in VLC, the left channel is the microphone and the right channel is the call.
5. **Silence and alignment.** Record 60 seconds: talk for 10, stay silent with nothing playing for 20, then play a video with speech for 10 and talk over it. Pass: the file is 60 seconds long; the system channel is silent during the quiet stretch, with no clicks; the video's speech and the voice over it line up within about a tenth of a second (look at the waveform in Audacity).
6. **Device switch.** During a recording, plug in a USB or Bluetooth headset and make it the default output, then unplug it. Pass: the system meter goes quiet for at most two seconds and comes back on the new device; `logs\recorder.log` has "system audio: now on …"; the recording finishes and plays through the switch. Unplug the microphone in use: the window shows the microphone as lost, and plugging it back brings it back.
7. **Live transcript.** Turn the live transcript on, download Parakeet, record a minute of Danish speech. Pass: the Live window floats above the Teams window, lines appear within about two seconds of each pause, and the text disappears when the recording stops. Repeat with Whisper.
8. **Queue offline.** Record a minute with the network off (aeroplane mode). Pass: the row says "No connection … Recordings are kept on this PC …"; after the network is back it uploads by itself and is confirmed.
9. **Quit and restart.** Close the window while an upload waits. Pass: the app stays in the notification area; Quit from its menu finishes; the next start lists the waiting recording and uploads it. Kill the process during a recording (Task Manager); the next start offers the interrupted recording, which plays to its last second.
10. **Language.** With Windows set to Danish, start the recorder. Pass: the window is in Danish and says "denne pc" where the Mac build says "denne Mac", and "Åbn Indstillinger" on the microphone banner.
11. **Uninstall and reinstall.** Uninstall from Settings → Apps, leaving "Delete the application data" unticked, install again. Pass: the recorder is still connected (the token is in Credential Manager) and the queue and models are still there.
