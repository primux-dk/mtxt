# mtxt

Meeting transcription a company hosts itself. A small recorder on each employee's machine, one Docker app on the company's own server, and every meeting becomes a transcript and an editable recap in the company's library: private or shared inside the company, and open to the company's AI tools through MCP.

Meetings only. No dictation.

**Status: specified, not built.** The spec is in [docs/spec.md](docs/spec.md), the decisions behind it in [docs/decisions.md](docs/decisions.md). The first install is the author's own. Every install runs in the owning company's own cloud account; nobody hosts it for anyone else.

## What it does

1. **Company login.** OIDC against Entra ID or Google Workspace. No local users.
2. **Desktop recorder.** Microphone plus system audio on Mac and Windows, bot-free, so a participant in someone else's Teams or Meet still gets a recording. Our own code, with [Vibe](https://github.com/thewh1teagle/vibe), [anarlog](https://github.com/fastrepl/anarlog) and [Meetily](https://github.com/Zackriya-Solutions/meetily) as references for capture and local models.
3. **Live transcript.** Optional, off by default, a local model in the recorder. A preview, never the record.
4. **Other capture.** Record in the browser, upload a file, and pull Teams or Meet recordings for meetings the company organised.
5. **Swappable speech-to-text.** AssemblyAI, Azure Speech, ElevenLabs Scribe, or a local Whisper or Parakeet model. One per install, chosen by the company's own contract.
6. **Keyterms and corrections.** A company dictionary. Danish first.
7. **Speakers.** Diarization, renaming, and labels that can link to a colleague in the directory.
8. **Recap.** The AI drafts it from a template; the owner finishes it in a Notion-style editor inside the platform. Markdown stored, a version per save, AI text and human edits told apart. Export markdown and docx.
9. **Private and shared.** Each meeting is private, shared with named colleagues, or company-wide. Search and MCP respect it.
10. **Retention, audit, MCP.** Delete after N days per install with a keep flag per meeting. A log of who opened what. An MCP server with the same company login, scoped to what the user may see, with read and write tools.

## Stack

- Library: Next.js with shadcn/ui, deployed to Cloudflare Workers in the company's own account: R2 for audio, Queues for jobs, Durable Objects for upload sessions, D1 for data, AI Gateway in front of the language model. Storage, queue and database sit behind adapters so a Docker edition stays possible. The recap editor is Tiptap core with the open React UI components.
- Recorder: Tauri 2 and Rust, our own code under `apps/recorder` in this repo. The library is `apps/web`; the contract between them is `packages/contract`.
- Speech-to-text and language models are adapters. The app holds no opinion about the provider.

## Licence

PolyForm Noncommercial 1.0.0, the same as scene-loop. Free for noncommercial use; a company that runs it in its business needs a commercial licence from Primux. Source-available, not open source in the OSI sense. See [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md) for third-party code and model attributions.

Built by [Primux](https://primux.dk).
