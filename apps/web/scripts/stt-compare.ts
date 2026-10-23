/*
  Runs a second speech-to-text provider on a recording that already has a
  transcript, for the spec's phase-1 comparison (Workers AI Whisper on the
  same recording). Writes a second transcripts row with is_comparison = 1,
  which nothing in the app shows, and prints both texts' word counts and a
  word-level diff. A dev tool; no UI.

    pnpm stt:compare --recording <id> --provider workers-ai
    pnpm stt:compare --recording <id> --provider assemblyai
      --persist-to <dir>   the local state wrangler dev used (default .wrangler/state);
                           paths are relative to apps/web
      --vars <file>        secrets and vars to read instead of .dev.vars
      --remote             the deployed install's D1 and R2 (needs a wrangler login)

  Workers AI always runs remotely, so it needs a wrangler login, also against
  local data. In an e2e state, AUTH_TEST_MODE=1 and WORKERS_AI_FAKE_URL in the
  vars file point it at the fake instead (lib/stt/test-hooks.ts), with no login.
*/
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { getPlatformProxy } from 'wrangler';
import {
  createDb,
  ensureWebhookSecret,
  r2Storage,
  readSettings,
  schema,
  seal,
  workersAiSpeech,
  type Settings,
} from '@mtxt/adapters';
import { providerFor, type SttResult } from '../lib/stt';
import { diffStats, formatDiff, wordDiff, words } from '../lib/stt/compare';
import { fakeSpeech } from '../lib/stt/test-hooks';
import { keytermList } from '../lib/transcription/job';
import { rawPath } from '../lib/transcription/store';

const PROVIDERS = { 'workers-ai': 'workers-ai-whisper', assemblyai: 'assemblyai' } as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const recordingId = arg('recording');
  const which = arg('provider') as keyof typeof PROVIDERS | undefined;
  if (!recordingId || !which || !(which in PROVIDERS)) {
    throw new Error('Usage: pnpm stt:compare --recording <id> --provider workers-ai|assemblyai');
  }
  const remote = process.argv.includes('--remote');
  const here = resolve(import.meta.dirname, '..');
  let configPath = join(here, 'wrangler.jsonc');
  let temp = false;
  if (remote) {
    // The deployed install's own data: the same config with D1 and R2 marked remote.
    temp = true;
    mkdirSync(join(here, '.wrangler'), { recursive: true });
    const text = readFileSync(configPath, 'utf8')
      .replace('"binding": "DB",', '"binding": "DB", "remote": true,')
      .replace('"binding": "AUDIO",', '"binding": "AUDIO", "remote": true,')
      .replace(/"main": "worker.ts",/, '')
      .replace(/"assets": \{[^}]*\},/, '')
      .replace(/"migrations_dir": "[^"]+",/, '');
    // Under .wrangler (git-ignored); the paths it had are taken out above.
    configPath = join(here, '.wrangler', `compare-${process.pid}.jsonc`);
    writeFileSync(configPath, text);
  }
  const persistTo = arg('persist-to');
  const envFile = arg('vars');
  // Remote bindings need a login: only for --remote, or for Workers AI unless a test vars file fakes it.
  const vars = envFile ? readFileSync(resolve(envFile), 'utf8') : '';
  const faked = /^AUTH_TEST_MODE=1$/m.test(vars) && /^WORKERS_AI_FAKE_URL=/m.test(vars);
  const proxy = await getPlatformProxy<CloudflareEnv>({
    configPath,
    remoteBindings: remote || (which === 'workers-ai' && !faked),
    ...(persistTo ? { persist: { path: join(resolve(persistTo), 'v3') } } : {}),
    ...(envFile ? { envFiles: [resolve(envFile)] } : {}),
  });
  try {
    const env = proxy.env;
    const db = createDb(env);
    const installId = env.INSTALL_ID;
    const rec = await db.query.recordings.findFirst({
      where: and(eq(schema.recordings.id, recordingId), eq(schema.recordings.installId, installId)),
    });
    if (!rec) throw new Error(`No recording ${recordingId} in install ${installId}.`);
    const primary = await db.query.transcripts.findFirst({
      where: and(
        eq(schema.transcripts.installId, installId),
        eq(schema.transcripts.recordingId, rec.id),
        eq(schema.transcripts.isComparison, false),
      ),
    });
    const primaryText = primary
      ? (
          await db
            .select({ text: schema.segments.text })
            .from(schema.segments)
            .where(
              and(
                eq(schema.segments.installId, installId),
                eq(schema.segments.transcriptId, primary.id),
              ),
            )
            .orderBy(asc(schema.segments.startMs))
        )
          .map((s) => s.text)
          .join(' ')
      : '';

    const settings = await readSettings(db, installId);
    const id = PROVIDERS[which];
    const provider = await providerFor(
      { ...settings, sttProvider: id as Settings['sttProvider'] },
      {
        settingsKey: env.SETTINGS_KEY,
        speech: fakeSpeech(env) ?? workersAiSpeech(env.AI),
        publicUrl: env.PUBLIC_URL,
        allowLocalPublicUrl: !remote,
        webhookSecret: () =>
          ensureWebhookSecret(db, installId, (plain) =>
            seal(plain, 'settings.webhook_secret', env.SETTINGS_KEY!),
          ),
      },
    );
    const storage = r2Storage(env.AUDIO);
    console.log(
      `Running ${id} on recording ${rec.id} (${rec.durationS} s, ${rec.sizeBytes} bytes)…`,
    );
    const submitted = await provider.submit({
      recordingId: rec.id,
      contentType: rec.contentType,
      sizeBytes: rec.sizeBytes,
      durationS: rec.durationS,
      language: settings.language,
      keyterms: await keytermList(db, installId),
      audio: async () => {
        const object = await storage.get(rec.storagePath);
        if (!object) throw new Error(`No audio at ${rec.storagePath}.`);
        return object.body;
      },
    });
    let result: SttResult;
    let jobId: string | null = null;
    if (submitted.kind === 'done') result = submitted.result;
    else {
      // An async provider: poll; the webhook it also sends is ignored for a comparison row.
      jobId = submitted.handle;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const fetched = await provider.fetch!(jobId);
        if (fetched.kind === 'done') {
          result = fetched.result;
          break;
        }
        if (fetched.kind === 'failed') throw new Error(`${id} failed: ${fetched.reason}`);
        process.stdout.write('.');
      }
      process.stdout.write('\n');
    }

    // The provider's own JSON and the segments it mapped to go to storage, like the primary's.
    const path = rawPath(installId, rec.id, id, true);
    await storage.put(path, JSON.stringify({ provider: result.raw, segments: result.segments }), {
      contentType: 'application/json',
    });
    await db.insert(schema.transcripts).values({
      installId,
      recordingId: rec.id,
      provider: id,
      model: result.model,
      language: result.language,
      rawJson: {},
      rawPath: path,
      status: 'done',
      providerJobId: jobId,
      isComparison: true,
    });

    const a = words(primaryText);
    const b = words(result.segments.map((s) => s.text).join(' '));
    console.log(
      `\n${primary ? `${primary.provider} (${primary.model})` : 'No primary transcript'}: ${a.length} words`,
    );
    console.log(`${id} (${result.model}): ${b.length} words`);
    try {
      const parts = wordDiff(a, b);
      const stats = diffStats(parts);
      console.log(
        `Same ${stats.same}, only in the first ${stats.removed}, only in the second ${stats.added}.\n`,
      );
      console.log(formatDiff(parts));
    } catch (error) {
      console.log((error as Error).message);
    }
  } finally {
    await proxy.dispose();
    if (temp) rmSync(configPath, { force: true });
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
