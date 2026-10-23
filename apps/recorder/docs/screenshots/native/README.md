# Native screenshots

Captured with `screencapture -l` from the installed app on Kristian's Mac (macOS 26, Apple silicon), connected to the author's own install with his Google account, on 2026-10-23. They show the native title bar and the real WebKit rendering.

## First build (`03fd722`, packet 9)

| File | What it shows |
| --- | --- |
| `main-recording.png` | A real recording: microphone and system audio meters moving (WebKit's native green; fixed in #13) |
| `live-recording.png` | The live window: Parakeet transcribing a Danish video playing in the browser |
| `main-transcribed.png` | After Stop: confirmed on the install and transcribed by the server |

The 125-second file had the microphone on the left (RMS −43 dB) and system audio on the right (RMS −24.7 dB).

## Current build (`e76c436`, after #13)

| File | What it shows |
| --- | --- |
| `v2-connected-after-reinstall.png` | After installing the new build: still connected (the Keychain token's id matched the binding) |
| `v2-device-0-start.png` … `v2-device-4-mac-out.png` | One recording while the input switched MacBook mic → RØDE NT-USB Mini → MacBook mic and the output MacBook speakers → LG HDR 4K → MacBook speakers, with speech playing. Meters in the accent colour; "Recording microphone and system audio" throughout |
| `v2-live-recording-1.png` | Live text in the first of two recordings in a row: timestamped lines |
| `v2-live-recording-2-partial.png`, `v2-live-recording-2.png` | The second recording: live text works again (the ONNX Runtime fix), the line in progress muted, then committed; nothing of the first recording left |
| `v2-row-menu.png` | The row menu, opened upwards near the end of the list |

Device switching, measured in the file in 3-second windows: both channels deliver through every switch; the microphone drops to about −41 dB on the RØDE (further from the speaker) and returns on the MacBook mic; system audio stays between −10 and −18 dB while speech plays; no gap was noted in the state file. The recording was confirmed and transcribed by ElevenLabs Scribe.

Found during these checks and fixed with them: "Save audio to…" was offered while a recording was still being recorded, and saved a copy of the unfinished file (22 of 30 seconds).
