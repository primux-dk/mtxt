# Native screenshots

Captured with `screencapture -l` from the installed app (`/Applications/mtxt Recorder.app`, universal build of `03fd722`), connected to the author's own install, on 2026-10-23. They show the native title bar and the real WebKit rendering.

| File | What it shows |
| --- | --- |
| `main-recording.png` | A real recording: microphone and system audio meters moving, 00:00:32 |
| `live-recording.png` | The live window during that recording: Parakeet transcribing a Danish video playing in the browser |
| `main-transcribed.png` | After Stop: the recording confirmed on the install and transcribed by the server |

The meters are WebKit's native green here; the build in this PR draws them in the accent colour.
