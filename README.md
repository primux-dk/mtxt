# mtxt

Meeting transcription a company hosts itself. A small recorder on each employee's machine, one Docker app on the company's own server, and every meeting becomes a transcript and an editable recap in the company's library: private or shared inside the company, and open to the company's AI tools through MCP.

Meetings only. No dictation.

**Status: specified, not built.** The spec is in [docs/spec.md](docs/spec.md), the decisions behind it in [docs/decisions.md](docs/decisions.md). The first install is planned for a Danish organisation in November 2026.

## What it does

1. **Company login.** OIDC against Entra ID or Google Workspace. No local users.
2. **Desktop recorder.** Microphone plus system audio on Mac and Windows, bot-free, so a participant in someone else's Teams or Meet still gets a recording. Forked from [Vibe](https://github.com/thewh1teagle/vibe) (MIT).
3. **Live transcript.** Optional, off by default, a local model in the recorder. A preview, never the record.
4. **Other capture.** Record in the browser, upload a file, and pull Teams or Meet recordings for meetings the company organised.
5. **Swappable speech-to-text.** AssemblyAI, Azure Speech, ElevenLabs Scribe, or a local Whisper or Parakeet model. One per install, chosen by the company's own contract.
6. **Keyterms and corrections.** A company dictionary. Danish first.
7. **Speakers.** Diarization, renaming, and labels that can link to a colleague in the directory.
8. **Recap.** The AI drafts it from a template; the owner finishes it in a Notion-style editor inside the platform. Markdown stored, a version per save, AI text and human edits told apart. Export markdown and docx.
9. **Private and shared.** Each meeting is private, shared with named colleagues, or company-wide. Search and MCP respect it.
10. **Retention, audit, MCP.** Delete after N days per install with a keep flag per meeting. A log of who opened what. An MCP server with the same company login, scoped to what the user may see, with read and write tools.

## Stack

- Library: Laravel, Livewire, queue workers, Docker compose. The recap editor is Tiptap core with open extensions, in a Livewire island.
- Recorder: Tauri 2 and Rust, a fork of Vibe, in its own repository once the build starts.
- Speech-to-text and language models are adapters. The app holds no opinion about the provider.

## Licence

PolyForm Noncommercial 1.0.0, the same as scene-loop. Free for noncommercial use; a company that runs it in its business needs a commercial licence from Primux. Source-available, not open source in the OSI sense. See [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md) for third-party code and model attributions.

Built by [Primux](https://primux.dk).
