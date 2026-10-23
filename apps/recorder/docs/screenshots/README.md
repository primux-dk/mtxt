# Recorder screenshots

`main-*.png` and `live-*.png` are the recorder's own window pages (`index.html`, `live.html`, the real CSS and TypeScript) rendered in Chromium at 360 × 520 and 420 × 200, at 2×, from the fixture snapshots in `../../preview/fixtures.ts`. They show every state of the window, not the native title bar: a capture of the native window needs the Screen Recording permission, which the build machine did not have when these were taken.

| File | State |
| --- | --- |
| `main-setup.png` | First run: the install's address |
| `main-setup-error.png` | The install could not be reached, with the next step |
| `main-connecting.png` | Waiting for approval, with the pairing code |
| `main-empty.png` | Connected, no recordings yet (empty state 1) |
| `main-permissions.png` | The explanation before macOS asks |
| `main-denied.png` | Both permissions denied, with System Settings and Check again (empty state 3) |
| `main-figure05.png` | Figure 05: recording, Uploading 2/5, Confirmed, Waiting for network, the 24-hour warning |
| `main-uploading.png` | The same queue, not recording |
| `main-offline.png` | No connection to the install (empty state 2) |
| `main-signed-out.png` | The token was revoked: Signed out, Connect again |
| `main-hard.png` | Rule 13: a 4-hour, 200 MB recording, a 120-character title, æøå; transcribed, server error, rejected, file missing, the 7-day question, deleted, saved elsewhere; a model download in progress |
| `main-ask.png` | The 7-day question |
| `main-mic-only.png` | System audio not allowed: recording the microphone only |
| `main-model-dialog.png` | The size warning before a model download |
| `main-review.png`, `main-review-scrolled.png`, `main-review-da.png` | After the Codex review: Connect to another install, Recorded by another user, a recovered recording (Upload as me), a write failure, an unreadable file, transcription failed on the server, a damaged entry, an interrupted recording (Upload), a change not saved on the Mac (Try again); each with its next step |
| `main-mic-lost.png` | The microphone was disconnected during a recording; system audio continues |
| `main-state-save.png` | The queue could not be saved on the Mac, with Try again |
| `main-figure05-da.png`, `main-figure05-dark.png`, `main-hard-da-dark.png` | Danish and dark |
| `live-*.png` | The live window: listening, loading, paused, no model, error; Danish and dark |
| `manual-run-*.png` | The library's connect page with the matching pairing code, and the meeting the manual run uploaded, on a local `wrangler dev` install |
