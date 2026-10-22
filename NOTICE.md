# Third-party code and models

Bundled:

- **Mona Sans** (GitHub, SIL Open Font License 1.1): the product typeface, in `docs/design/fonts/`, copied unchanged. Licence: `docs/design/fonts/LICENSE-mona-sans.txt`.

Planned, to be recorded here when they land:

- Rust crates the recorder will depend on (cpal, whisper-rs, ONNX runtime bindings, Tauri plugins), each under MIT or Apache-2.0, listed here when added. Vibe, anarlog and Meetily are read as references; no code from them is in this repository.
- **Parakeet TDT 0.6B v3** (NVIDIA, CC-BY-4.0): local speech-to-text model, downloaded by the recorder on first run. Attribution: "Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC-BY-4.0."
- **Whisper large-v3-turbo** (OpenAI, MIT): fallback local model.
- **Tiptap** (@tiptap/core and open extensions, MIT): the recap editor. No Pro extensions.

Speech-to-text and language-model providers are called over their APIs under the installing company's own agreement with them. None of their code is in this repository.
