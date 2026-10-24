# Deploying an install

One install is one Worker and its resources in the owning company's own Cloudflare account, on a hostname in a zone of that account. `deploy/install.mjs` creates what is missing, reuses what is there, and deploys. It never deletes anything. This page is the runbook.

## What an install is made of

| Resource | Default name | Notes |
| --- | --- | --- |
| Worker | `mtxt-web` | The Next.js app (OpenNext), the queue consumer, the nightly Cron Trigger (03:00 UTC) and the `UploadSession` Durable Object class. `workers.dev` and preview URLs are off; the app answers only on its custom domain. |
| Custom domain | the install's hostname | Attached by the deploy. Cloudflare creates the DNS record and the certificate. |
| D1 database | `mtxt-db` | Created with jurisdiction `eu`. |
| R2 bucket | `mtxt-audio` | Created with jurisdiction `eu`. Audio and exports. |
| Queue | `mtxt-jobs` | Created with jurisdiction `eu`. Transcription, recap, drain and retention jobs. One message per batch, six deliveries at most (the first and five retries, `max_retries` 5). |
| Dead-letter queue | `mtxt-jobs-dlq` | Created with jurisdiction `eu`. A message that fails all six deliveries lands here. Nothing consumes it; Cloudflare keeps a message for four days by default. |
| AI Gateway | `mtxt-gateway` | Optional. Logs and cache off, so prompts with meeting content are not kept. See "AI Gateway" below. |
| Worker secrets | | `AUTH_SECRET`, `SETTINGS_KEY`, `OIDC_PROVIDER`, `OIDC_TENANT_ID`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`. |

The names can be changed per install under `names` in the install config. The Durable Object migration (`v1`, `UploadSession`) and the queue consumer settings come from `apps/web/wrangler.jsonc`, so every install gets the same ones.

## Prerequisites

- Node 22 and pnpm 12 (`corepack enable`), and `pnpm install` at the repository root.
- A Cloudflare login that can reach the account: `npx wrangler login` (OAuth), or `CLOUDFLARE_API_TOKEN` set to a token for that account. A token needs at least Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, AI Gateway Edit and Account Settings Read, plus Zone: Zone Read and Workers Routes Edit on the install's zone. The OAuth login was checked; the token list was not.
- For the AI Gateway with an OAuth login: the Cloudflare CLI (`npm i -g cf`, then `cf auth login`). Without it the run skips the gateway.
- The hostname's zone is active in the same account, and the hostname has no DNS record yet.
- An app registration for the company login, with this redirect URI:
  - Google Workspace: an OAuth client of type "Web application" in the company's Google Cloud project, with the OAuth consent screen set to Internal so only the Workspace's own accounts can sign in. Redirect URI `https://<host>/api/auth/callback/google`. The tenant value is the Workspace domain, for example `example.com`.
  - Entra ID: a single-tenant app registration with a client secret. Redirect URI `https://<host>/api/auth/callback/microsoft-entra-id`. The tenant value is the directory (tenant) id, a GUID.
- For transcription with AssemblyAI: an API key from the company's own AssemblyAI account. The install calls AssemblyAI's EU endpoint.

## The one command

1. Copy the example into `deploy/installs/` (that folder is not in git) and fill it in:

   ```sh
   mkdir -p deploy/installs
   cp deploy/install.example.json deploy/installs/<name>.json
   ```

   It holds the account id, hostname, install id, product name, company name, languages, time zone, identity provider and speech-to-text provider. The install id goes into every row and never changes.
2. Put the secrets in the file `secretsFile` names (default `~/.config/mtxt/<installId>.env`), one `NAME=value` per line:

   ```sh
   # google or entra
   MTXT_OIDC_PROVIDER=google
   # Google: the Workspace domain. Entra: the tenant GUID.
   MTXT_OIDC_TENANT_ID=example.com
   MTXT_OIDC_CLIENT_ID=...
   MTXT_OIDC_CLIENT_SECRET=...
   # Optional: the key for settings.sttProvider, assemblyai or elevenlabs
   MTXT_ASSEMBLYAI_KEY=...
   MTXT_ELEVENLABS_KEY=...
   ```

   A value in quotes is kept as written. Without quotes, a `#` after a space starts a comment.

   The same names in the shell win over the file. `MTXT_AUTH_SECRET` and `MTXT_SETTINGS_KEY` are generated on the first run and appended to the file, which is then readable by you only. Keep a copy of that file in the company's password manager: the Worker holds the same values but never shows them again.

3. Look at the plan, then run it:

   ```sh
   pnpm deploy:install --config deploy/installs/<name>.json --dry-run
   pnpm deploy:install --config deploy/installs/<name>.json
   ```

The run prints what exists and what it will do, then in order: creates the missing D1 database, R2 bucket, queues and AI Gateway; writes `apps/web/wrangler.<installId>.jsonc` with the account id, the resource ids, the hostname as custom domain and the install's vars (not in git); applies the pending D1 migrations remotely; writes the settings row if it does not exist (product name, company name, languages, time zone, gateway id), and on an existing row sets the config's time zone while the row still has the default UTC; seals the speech-to-text key into the row if the row has no provider yet (`MTXT_ASSEMBLYAI_KEY` for `assemblyai`, `MTXT_ELEVENLABS_KEY` for `elevenlabs`; with no `sttProvider` in the config, an AssemblyAI key alone means AssemblyAI); builds with OpenNext, checks that the bundle holds no e2e fake provider and deploys; puts the Worker secrets the Worker lacks; and checks the custom domain. It never prints a secret.

A second run changes nothing. Resources are found by name; the settings row is left alone once it exists, so the settings page stays the source; a secret is put only when the Worker lacks it; and the Worker is deployed only when a build input changed since the deployed version (its tag says which): `apps/web`, `packages`, the lockfile, the root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.node-version`, an `.npmrc` if there is one, or the generated config. `--force-deploy` deploys anyway.

Without OIDC values the install deploys and the login page names the secrets it lacks. Add them to the secrets file and run the command again: it puts the secrets and leaves the code alone. `"$MTXT_WRANGLER" secret put OIDC_CLIENT_ID -c "$MTXT_CFG"` works as well (see "Commands against an install"). The first request after that writes them into the settings row, and the first person to sign in becomes the install's admin. From then on the identity provider is changed on the settings page; the OIDC secrets are read only while the row has none.

Then check it from outside:

```sh
pnpm deploy:smoke <host> --product "<product name>"
pnpm deploy:install --config deploy/installs/<name>.json --status
```

The smoke test checks that `/login` renders (with the product name), that `/` and `/design` redirect to the login, and that the webhook, the recordings API and the audio route answer 401 without a session or secret. `--status` lists the Worker, the custom domain, the deployed tag, the secrets set and missing, the D1 and R2 jurisdictions, the queue consumers, the cron triggers, the pending migrations and the gateway.

## Commands against an install

Every command below runs against one install's account and resources. Load them from its config first, in the shell you run the commands in:

```sh
eval "$(node deploy/install.mjs --config deploy/installs/<name>.json --print-env)"
```

That exports `CLOUDFLARE_ACCOUNT_ID`, `MTXT_CFG` (the generated wrangler config, which pins the account), `MTXT_WRANGLER` (the repository's wrangler), `MTXT_INSTALL_ID` and the resource names from the config: `MTXT_WORKER`, `MTXT_DB`, `MTXT_BUCKET`, `MTXT_QUEUE`, `MTXT_DLQ` and `MTXT_GATEWAY`. It makes no API call. If the generated config is missing or stale, write it again with `pnpm deploy:install --config deploy/installs/<name>.json --config-only`, which reads the resources and creates nothing.

## AI Gateway

Wrangler's OAuth login has no AI Gateway permission, and `wrangler login` cannot ask for one. When the API refuses wrangler's login, the run uses the Cloudflare CLI (`cf`, logged in with `cf auth login`) to find and create the gateway, with logs and the cache off. With an API token that has AI Gateway Edit, the run uses the token. With neither, it skips the gateway and says so: create it in the dashboard (AI, AI Gateway, Create gateway, id `mtxt-gateway`, logs off, no cache) and enter its id on the settings page.

A gateway the run creates goes into the settings row's `ai_gateway_id` when the row has none. A later run leaves the column alone, so an admin who clears it on the settings page keeps it cleared.

## Rotating the Worker secrets

Put the new value in the secrets file and run the command with `--replace-secrets`, or use `"$MTXT_WRANGLER" secret put <NAME> -c "$MTXT_CFG"`. Both take effect at once, without a code deploy.

- `AUTH_SECRET` signs the session cookies. A new value signs everyone out; they sign in again. Nothing else breaks. Rotate it when it may have leaked.
- `SETTINGS_KEY` seals the identity provider's client secret, the speech-to-text key and the webhook secret in the settings row. With a new key none of them opens: the login page says the login is not set up correctly, transcription fails with `config`, and AssemblyAI's webhooks are refused. There is no reseal step. After rotating, clear the sealed values so the install sets itself up again from the Worker secrets:

  ```sh
  "$MTXT_WRANGLER" d1 execute DB --remote -c "$MTXT_CFG" --command \
    "UPDATE settings SET identity_provider = NULL, oidc_tenant_id = NULL, oidc_client_id = NULL, oidc_client_secret = NULL, stt_provider = NULL, stt_api_key = NULL, webhook_secret = NULL WHERE install_id = '$MTXT_INSTALL_ID'"
  ```

  The OIDC secrets must be on the Worker for this. The next request seals the login again under the new key and makes a new webhook secret; an admin enters the speech-to-text key again on the settings page, which also starts the recordings that waited meanwhile. Rotate it only when it may have leaked.

## Updating an install

```sh
git pull
pnpm install
pnpm deploy:install --config deploy/installs/<name>.json
pnpm deploy:smoke <host> --product "<product name>"
```

The run applies new migrations before it deploys the new code, so for a moment the old code runs on the new schema. Migrations in this repository add and backfill; they do not drop what the running code reads. A deploy that goes wrong is rolled back with `"$MTXT_WRANGLER" rollback -c "$MTXT_CFG"`; a migration is not rolled back by that.

## Backing up D1

D1 keeps its own point-in-time history (Time Travel: 30 days on a paid Workers plan, 7 on the free plan). That is the first way back:

```sh
"$MTXT_WRANGLER" d1 time-travel info DB -c "$MTXT_CFG"
"$MTXT_WRANGLER" d1 time-travel restore DB -c "$MTXT_CFG" --timestamp <ISO time>
```

For a copy outside Cloudflare, `wrangler d1 export` does not work: it refuses a database with a virtual table, and the search index is an FTS5 table. `deploy/backup.mjs` exports the data of every ordinary table instead:

```sh
pnpm deploy:backup --config deploy/installs/<name>.json --out <dir>
```

The script checks that the generated config carries the install config's account, Worker and database before it calls wrangler. The folder holds `data.sql` and `manifest.json` (the migrations the database was at, and the row count per table, counted in the export itself). It leaves the search index out. To restore, create an empty database and restore into it:

```sh
"$MTXT_WRANGLER" d1 create mtxt-db-restored --jurisdiction eu -c "$MTXT_CFG"
pnpm deploy:backup --config deploy/installs/<name>.json --restore <dir> --into mtxt-db-restored
```

The restore refuses a target with a row in any table, or with migrations the backup was not taken at. It refuses the install's live database unless `--into-live --yes-i-mean-it` are both given, and even then only if that database is empty. It applies the migrations the backup was taken at, imports the data, applies the newer migrations, rebuilds the search index with migration 0006's statements, and checks every table's row count. Then set `"names": { "database": "mtxt-db-restored" }` in the install config and run the install command, which points the Worker at it. A backup holds meeting content and the sealed settings: store it as carefully as the database. The audio in R2 is not part of it; copy the bucket with an S3 tool and an R2 API token if you need that too.

## Removing an install

This deletes the company's meetings. Take a backup first if anything should be kept. In this order:

```sh
eval "$(node deploy/install.mjs --config deploy/installs/<name>.json --print-env)"
# The Worker with its secrets and Durable Objects.
"$MTXT_WRANGLER" delete -c "$MTXT_CFG"
"$MTXT_WRANGLER" queues delete "$MTXT_QUEUE" -c "$MTXT_CFG"
"$MTXT_WRANGLER" queues delete "$MTXT_DLQ" -c "$MTXT_CFG"
"$MTXT_WRANGLER" d1 delete "$MTXT_DB" -c "$MTXT_CFG"
# Only when empty: empty the bucket in the dashboard first.
"$MTXT_WRANGLER" r2 bucket delete "$MTXT_BUCKET" --jurisdiction eu -c "$MTXT_CFG"
cf ai-gateway gateways delete "$MTXT_GATEWAY"
```

After a restore, `MTXT_DB` is the restored database, because the install config names it. Check in the dashboard that the custom domain went with the Worker. Then delete the app registration with the identity provider, `deploy/installs/<name>.json`, the generated config and the secrets file.

## EU data

From `docs/spec.md`, checked against Cloudflare's documentation on 2026-10-22 and 2026-10-23:

- Audio at rest is in an R2 bucket with the EU jurisdiction, and upload sessions are Durable Objects in the `eu` jurisdiction. Both work on any plan.
- The D1 database and the queues are created with the EU jurisdiction. A jurisdiction is set when the resource is created and cannot be added later, so an install created before 2026-10-23 without it keeps its database where it is.
- Where the Worker code runs is best effort, normally the data centre nearest the request, unless the company has the Data Localization Suite, an Enterprise-only add-on.
- Workers AI and AI Gateway are not covered by Regional Services. AssemblyAI is called on its EU endpoint, directly, because AI Gateway does not support it.

Processing is not promised to stay in the EU. The settings page's data-flow panel says the same.
