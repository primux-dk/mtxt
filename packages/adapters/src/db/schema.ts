/**
 * The database schema, one per install. Columns follow docs/spec.md "Data model".
 *
 * Written on drizzle-orm/sqlite-core, which D1 and SQLite share. Postgres (a later
 * Docker edition) needs its own pg-core copy of these tables; the column names and
 * types stay the same so queries in apps/web do not change.
 *
 * Every row carries `install_id`. v1 runs one company per install and no code
 * assumes otherwise; the column is there so a row can never be read into the
 * wrong install by mistake.
 *
 * Ids are text (UUIDs from crypto.randomUUID()). Times are integer milliseconds.
 */
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const VISIBILITIES = ['private', 'shared', 'company'] as const;
export const RECORDING_SOURCES = [
  'desktop',
  'browser',
  'upload',
  'teams',
  'meet',
  'device',
] as const;
export const RECORDING_STATUSES = [
  'uploading',
  'confirmed',
  'transcribing',
  'transcribed',
  'failed',
] as const;
export const AUDIT_ACTIONS = [
  'opened',
  'exported',
  'shared',
  'visibility_changed',
  'deleted',
  'mcp_read',
  'mcp_write',
  'recorder_connected',
  'recorder_disconnected',
] as const;
export const IDENTITY_PROVIDERS = ['entra', 'google'] as const;
export const STT_PROVIDERS = [
  'assemblyai',
  'azure',
  'elevenlabs',
  'workers-ai-whisper',
  'local-whisper',
  'local-parakeet',
] as const;
export const INTERFACE_LANGUAGES = ['en', 'da'] as const;
/** The recap model's provider (docs/spec.md, "Recap model"). Workers AI needs no key. */
export const RECAP_PROVIDERS = ['workers-ai', 'anthropic', 'openai', 'azure-openai'] as const;
/** A recap is being drafted by the AI, holds a version, or its last draft failed. */
export const RECAP_STATUSES = ['drafting', 'ready', 'failed'] as const;
/** A transcript waits for an async provider, holds the result, or records that the provider failed. */
export const TRANSCRIPT_STATUSES = ['pending', 'done', 'failed'] as const;
/** A recorder grant: approved on /connect and waiting for the poll, cancelled there, or exchanged for a token. */
export const RECORDER_GRANT_STATUSES = ['approved', 'denied', 'redeemed'] as const;
/** The settings page's "Recording sources": where a meeting may come from. */
export const CAPTURE_SOURCES = ['desktop', 'upload', 'browser', 'teams', 'meet'] as const;

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const installId = () => text('install_id').notNull();
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const createdAt = (name = 'created_at') =>
  timestamp(name)
    .notNull()
    .default(sql`(cast(unixepoch('subsec') * 1000 as integer))`);
const bool = (name: string) => integer(name, { mode: 'boolean' });

/** A CHECK that holds an enum column to its values. NULL passes, so nullable columns stay nullable. */
const inValues = (table: string, column: string, values: readonly string[]) =>
  check(
    `${table}_${column}_check`,
    sql.raw(`"${column}" IN (${values.map((v) => `'${v}'`).join(', ')})`),
  );

export const users = sqliteTable(
  'users',
  {
    id: id(),
    installId: installId(),
    oidcSubject: text('oidc_subject').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    isAdmin: bool('is_admin').notNull().default(false),
  },
  (t) => [
    uniqueIndex('users_install_subject').on(t.installId, t.oidcSubject),
    /** One user row per address: identity is the subject, and an address never names two. */
    uniqueIndex('users_install_email').on(t.installId, t.email),
  ],
);

export const templates = sqliteTable(
  'templates',
  {
    id: id(),
    installId: installId(),
    name: text('name').notNull(),
    /** `templateNameKey(name)`: trimmed and case-folded, so names that differ only in case collide. */
    nameKey: text('name_key').notNull().default(''),
    bodyMd: text('body_md').notNull(),
    isDefault: bool('is_default').notNull().default(false),
  },
  (t) => [
    index('templates_install').on(t.installId),
    uniqueIndex('templates_install_name_key').on(t.installId, t.nameKey),
  ],
);

export const meetings = sqliteTable(
  'meetings',
  {
    id: id(),
    installId: installId(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    /**
     * The title NFKC-normalised and lower-cased in JavaScript (foldTitle), for
     * search. SQLite's LIKE and lower() fold ASCII only, so "MØDE" would not
     * find "Møde". Null for rows from before migration 0001 until
     * backfillTitleKeys() has run; the app writes it on create and rename.
     */
    titleFolded: text('title_folded'),
    startedAt: timestamp('started_at').notNull(),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('private'),
    keep: bool('keep').notNull().default(false),
    templateId: text('template_id').references(() => templates.id),
    /** Archive is not delete (behaviour.md rule 3): hidden from library views, restorable. */
    archivedAt: timestamp('archived_at'),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    index('meetings_owner').on(t.ownerId),
    index('meetings_template').on(t.templateId),
    index('meetings_install_owner').on(t.installId, t.ownerId),
    index('meetings_install_visibility').on(t.installId, t.visibility),
    index('meetings_install_started').on(t.installId, t.startedAt),
    inValues('meetings', 'visibility', VISIBILITIES),
  ],
);

/** Rows exist only for `shared` visibility. */
export const meetingShares = sqliteTable(
  'meeting_shares',
  {
    installId: installId(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.userId] }),
    index('meeting_shares_user').on(t.userId),
    index('meeting_shares_install_user').on(t.installId, t.userId),
  ],
);

export const recordings = sqliteTable(
  'recordings',
  {
    id: id(),
    installId: installId(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => users.id),
    source: text('source', { enum: RECORDING_SOURCES }).notNull(),
    isPrimary: bool('is_primary').notNull().default(false),
    durationS: integer('duration_s').notNull(),
    /**
     * '' while a browser recording is still being made, set at complete. The
     * API answers null for ''. Kept NOT NULL so migration 0001 stays additive:
     * SQLite cannot drop NOT NULL without rebuilding the table, and D1's
     * rebuild cascades into transcripts and segments.
     */
    sha256: text('sha256').notNull(),
    /** 0 while a browser recording is still being made, set at complete; null in the API. */
    sizeBytes: integer('size_bytes').notNull(),
    /** An audio or video MIME type. Rows from before 0001 get one from their file extension. */
    contentType: text('content_type').notNull().default('audio/webm'),
    storagePath: text('storage_path').notNull(),
    status: text('status', { enum: RECORDING_STATUSES }).notNull().default('uploading'),
    /** A contract error code when status is failed, for example `hash_mismatch` or `stt_failed`. */
    failure: text('failure'),
    /**
     * What the speech-to-text provider said when transcription failed, in its
     * own words (never a secret). The page shows it under the localised line
     * for `failure`. Null for upload failures and while nothing has failed.
     */
    failureReason: text('failure_reason'),
    /**
     * When the recording was created. A constant SQL default, because ALTER
     * TABLE ADD COLUMN takes no expression; the app sets the real time, and
     * 0001 backfills older rows with their meeting's start.
     */
    createdAt: timestamp('created_at')
      .notNull()
      .default(sql`0`)
      .$defaultFn(() => new Date()),
    /** When the hash matched. The recorder's 7-day local timer starts here. */
    confirmedAt: timestamp('confirmed_at'),
    deleteAudioAt: timestamp('delete_audio_at'),
  },
  (t) => [
    index('recordings_meeting').on(t.meetingId),
    index('recordings_uploaded_by').on(t.uploadedBy),
    index('recordings_install_delete_audio').on(t.installId, t.deleteAudioAt),
    /** One primary recording per meeting. */
    uniqueIndex('recordings_one_primary')
      .on(t.meetingId)
      .where(sql`"is_primary" = 1`),
    inValues('recordings', 'source', RECORDING_SOURCES),
    inValues('recordings', 'status', RECORDING_STATUSES),
  ],
);

export const transcripts = sqliteTable(
  'transcripts',
  {
    id: id(),
    installId: installId(),
    recordingId: text('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** '' while pending. */
    language: text('language').notNull(),
    /** The provider's own response, kept whole. `{}` while pending. */
    rawJson: text('raw_json', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
    /**
     * TRANSCRIPT_STATUSES. Checked by the app, not by a CHECK: SQLite cannot
     * add a table constraint without rebuilding the table, and D1's rebuild
     * cascades (decisions.md, packet 3).
     */
    status: text('status', { enum: TRANSCRIPT_STATUSES }).notNull().default('done'),
    /** The provider's id for an async job (AssemblyAI's transcript id); null for sync providers. */
    providerJobId: text('provider_job_id'),
    /** A second provider's transcript for the comparison tool. Never shown in the app. */
    isComparison: bool('is_comparison').notNull().default(false),
    /**
     * The job delivery that holds the row: set by one conditional UPDATE, so
     * two deliveries never both submit. Every later write by the job names
     * `claim_token`. A claim older than the lease may be taken over.
     */
    claimedAt: timestamp('claimed_at'),
    claimToken: text('claim_token'),
    /** When the claim lapses (15 minutes after it is taken). A held delivery retries until then. */
    claimExpiresAt: timestamp('claim_expires_at'),
    /** The current attempt's polling deadline: past it, a job the provider still has is failed as a timeout. */
    pollDeadlineAt: timestamp('poll_deadline_at'),
    /**
     * Where the provider's raw result lives in storage
     * (`transcripts/{install}/{recording}/{provider}-{claim_token}.json`), set
     * by the completion that won. `raw_json` is no longer written beyond `{}`:
     * a full result can pass D1's 2 MB value limit.
     */
    rawPath: text('raw_path'),
  },
  (t) => [
    /** One server transcript per recording; the live preview is never stored. Comparisons sit beside it. */
    uniqueIndex('transcripts_recording')
      .on(t.recordingId)
      .where(sql`"is_comparison" = 0`),
    /** The same provider job never makes two rows in an install (a replayed webhook, a retried job). */
    uniqueIndex('transcripts_install_provider_job').on(t.installId, t.provider, t.providerJobId),
  ],
);

/**
 * The recap job a completed transcript owes, written in the completion
 * batch. `sent_at` is set once the queue took the message; a later delivery
 * re-sends a row left unsent for over a minute.
 */
export const recapOutbox = sqliteTable(
  'recap_outbox',
  {
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    installId: installId(),
    meetingId: text('meeting_id').notNull(),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at'),
  },
  (t) => [
    primaryKey({ columns: [t.transcriptId] }),
    index('recap_outbox_install_unsent').on(t.installId, t.sentAt),
  ],
);

/**
 * Recap jobs the consumer has taken, by transcript: a redelivered or
 * duplicated recap message for the same transcript is skipped.
 */
export const recapJobsSeen = sqliteTable(
  'recap_jobs_seen',
  {
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    installId: installId(),
    seenAt: createdAt('seen_at'),
  },
  (t) => [primaryKey({ columns: [t.transcriptId] })],
);

/** A label can link to a directory user; externals stay plain labels. */
export const speakers = sqliteTable(
  'speakers',
  {
    id: id(),
    installId: installId(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    userId: text('user_id').references(() => users.id),
    /**
     * The provider's speaker number, from 0. A second recording of the same
     * meeting reuses the row for the same number, so a rename holds across
     * them. Null for a speaker added by hand.
     */
    speakerIndex: integer('speaker_index'),
  },
  (t) => [
    index('speakers_meeting').on(t.meetingId),
    index('speakers_user').on(t.userId),
    uniqueIndex('speakers_meeting_index')
      .on(t.meetingId, t.speakerIndex)
      .where(sql`"speaker_index" is not null`),
  ],
);

export const segments = sqliteTable(
  'segments',
  {
    id: id(),
    installId: installId(),
    transcriptId: text('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'cascade' }),
    speakerId: text('speaker_id').references(() => speakers.id),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    text: text('text').notNull(),
  },
  (t) => [
    index('segments_transcript_start').on(t.transcriptId, t.startMs),
    index('segments_speaker').on(t.speakerId),
  ],
);

export const recaps = sqliteTable(
  'recaps',
  {
    id: id(),
    installId: installId(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    templateId: text('template_id').references(() => templates.id),
    bodyMd: text('body_md').notNull().default(''),
    currentVersionId: text('current_version_id').references(
      (): AnySQLiteColumn => recapVersions.id,
    ),
    docxPath: text('docx_path'),
    /**
     * RECAP_STATUSES, checked by the app (a CHECK would rebuild the table).
     * `failed` keeps the current version, if there is one.
     */
    status: text('status', { enum: RECAP_STATUSES }).notNull().default('ready'),
    /** A fixed reason and the HTTP status (`rate_limited:429`), never the provider's own text. */
    failureReason: text('failure_reason'),
    /** The AI draft being written now. A draft whose token is no longer here writes nothing. */
    draftToken: text('draft_token'),
  },
  (t) => [
    uniqueIndex('recaps_meeting').on(t.meetingId),
    index('recaps_template').on(t.templateId),
    index('recaps_current_version').on(t.currentVersionId),
  ],
);

/** One per save. `author_id` null means the AI draft (version 1). */
export const recapVersions = sqliteTable(
  'recap_versions',
  {
    id: id(),
    installId: installId(),
    recapId: text('recap_id')
      .notNull()
      .references((): AnySQLiteColumn => recaps.id, { onDelete: 'cascade' }),
    /** 1, 2, 3, ... per recap. Unique, so two saves on the same base cannot both land. */
    number: integer('number').notNull().default(0),
    authorId: text('author_id').references(() => users.id),
    bodyMd: text('body_md').notNull(),
    /** What made the version, when it is not a plain save: "Restored from v2", a chunked draft. */
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recap_versions_recap_number').on(t.recapId, t.number),
    index('recap_versions_recap_created').on(t.recapId, t.createdAt),
    index('recap_versions_author').on(t.authorId),
  ],
);

/**
 * The recap's decisions block, one row per item in order: written with every
 * version (lib/recap/decisions.ts), so the rows always match the current body.
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: id(),
    installId: installId(),
    recapId: text('recap_id')
      .notNull()
      .references(() => recaps.id, { onDelete: 'cascade' }),
    /** The item's place in the block, from 0. */
    position: integer('position').notNull().default(0),
    text: text('text').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id),
    done: bool('done').notNull().default(false),
  },
  (t) => [index('decisions_recap').on(t.recapId), index('decisions_owner').on(t.ownerUserId)],
);

/**
 * Every image uploaded into a meeting's recap, written before the object is
 * stored. Delete and retention find a meeting's images here, whether or not
 * the meeting has a transcript or a recap left.
 */
export const recapImages = sqliteTable(
  'recap_images',
  {
    id: id(),
    installId: installId(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    /** `images/{install}/{meeting}/{uuid}.{ext}` in storage. */
    path: text('path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('recap_images_meeting').on(t.meetingId),
    index('recap_images_install_meeting').on(t.installId, t.meetingId),
  ],
);

/** One list per install. */
export const keyterms = sqliteTable(
  'keyterms',
  {
    id: id(),
    installId: installId(),
    term: text('term').notNull(),
    boost: real('boost'),
  },
  (t) => [uniqueIndex('keyterms_install_term').on(t.installId, t.term)],
);

/**
 * One row per install: the whole admin surface (docs/spec.md "Settings page").
 * The provider secrets (`oidc_client_secret`, `stt_api_key`) are sealed with
 * AES-GCM under the Worker secret SETTINGS_KEY (src/secrets.ts); no code path
 * returns them to a browser.
 */
export const settings = sqliteTable(
  'settings',
  {
    installId: text('install_id').primaryKey(),
    productName: text('product_name').notNull(),
    /** Shown under the product name in the sidebar and in the login footer. */
    companyName: text('company_name'),
    themeAccent: text('theme_accent').notNull().default('#566b45'),
    themePrimary: text('theme_primary').notNull().default('#111111'),
    identityProvider: text('identity_provider', { enum: IDENTITY_PROVIDERS }),
    /** Entra: the directory (tenant) id. Google: the Workspace domain sign-in is held to. */
    oidcTenantId: text('oidc_tenant_id'),
    oidcClientId: text('oidc_client_id'),
    /** Sealed. */
    oidcClientSecret: text('oidc_client_secret'),
    sttProvider: text('stt_provider', { enum: STT_PROVIDERS }),
    /** Sealed. Workers AI Whisper and the local models have none. */
    sttApiKey: text('stt_api_key'),
    /** Azure: the region name. Null for every other provider. */
    sttRegion: text('stt_region'),
    /**
     * Sealed. Authenticates the speech-to-text provider's webhook back to the
     * install (AssemblyAI's custom auth header). Generated on the first
     * request that finds none; never shown and never logged.
     */
    webhookSecret: text('webhook_secret'),
    /** Cloudflare AI Gateway id. Workers AI and the recap model go through it when set. */
    aiGatewayId: text('ai_gateway_id'),
    /** RECAP_PROVIDERS. Checked by the app; a CHECK would rebuild the table. */
    recapProvider: text('recap_provider', { enum: RECAP_PROVIDERS })
      .notNull()
      .default('workers-ai'),
    /** The model id; null means the provider's default (lib/recap/models.ts). */
    recapModel: text('recap_model'),
    /** Sealed. Workers AI has none. */
    recapApiKey: text('recap_api_key'),
    /** Default transcription language: an ISO code, or `auto`. */
    language: text('language').notNull().default('auto'),
    interfaceLanguage: text('interface_language', { enum: INTERFACE_LANGUAGES })
      .notNull()
      .default('en'),
    liveTranscriptDefault: bool('live_transcript_default').notNull().default(false),
    defaultVisibility: text('default_visibility', { enum: VISIBILITIES })
      .notNull()
      .default('private'),
    retentionAudioDays: integer('retention_audio_days').notNull().default(30),
    retentionTranscriptDays: integer('retention_transcript_days').notNull().default(365),
    mcpEnabled: bool('mcp_enabled').notNull().default(false),
    /** JSON array of CAPTURE_SOURCES the install accepts. */
    recordingSources: text('recording_sources', { mode: 'json' })
      .$type<readonly (typeof CAPTURE_SOURCES)[number][]>()
      .notNull()
      .default(sql`'["desktop","upload","browser"]'`),
    /** JSON array of lower-case addresses. Empty on a fresh install: the first sign-in claims it. */
    adminEmails: text('admin_emails', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Set by the first sign-in's admin claim, or the first save of the list. The claim never runs again. */
    adminBootstrapClaimedAt: timestamp('admin_bootstrap_claimed_at'),
  },
  () => [
    inValues('settings', 'identity_provider', IDENTITY_PROVIDERS),
    inValues('settings', 'stt_provider', STT_PROVIDERS),
    inValues('settings', 'default_visibility', VISIBILITIES),
    inValues('settings', 'interface_language', INTERFACE_LANGUAGES),
  ],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: id(),
    installId: installId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    /** The meeting's title when the row was written. The row outlives the meeting; the title says what it was. */
    meetingTitle: text('meeting_title'),
    action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
    /** Before and after, for `shared` and `visibility_changed` (src/db/audit.ts, AuditDetails). */
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
    at: createdAt('at'),
  },
  (t) => [
    index('audit_events_user').on(t.userId),
    index('audit_events_meeting').on(t.meetingId),
    index('audit_events_install_at').on(t.installId, t.at),
    /** The `opened` dedupe looks up the user's latest row on a meeting. */
    index('audit_events_install_meeting_user_at').on(t.installId, t.meetingId, t.userId, t.at),
    index('audit_events_install_action_at').on(t.installId, t.action, t.at),
    inValues('audit_events', 'action', AUDIT_ACTIONS),
  ],
);

/**
 * Storage objects whose rows are already gone and that are still to be
 * deleted. A delete commits its rows (and its audit row) first and records
 * the paths here in the same transaction; only then are the objects
 * deleted, each row going with its object. What storage refuses stays here
 * for the nightly job, which retries a bounded number of times.
 */
export const storageCleanup = sqliteTable(
  'storage_cleanup',
  {
    id: id(),
    installId: installId(),
    path: text('path').notNull(),
    createdAt: createdAt(),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('storage_cleanup_install_attempts').on(t.installId, t.attempts, t.createdAt)],
);

/**
 * A desktop recorder's bearer token (docs/spec.md "Recorder connection").
 * Only the SHA-256 of the token is stored, never the token. Bound to one
 * user and one device name; revoked by Disconnect or the recorder itself.
 */
export const recorderTokens = sqliteTable(
  'recorder_tokens',
  {
    id: id(),
    installId: installId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    deviceName: text('device_name').notNull(),
    /** Lower-case hex SHA-256 of the whole token, `mtxt_` included. */
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    /** Written at most once per 5 minutes. */
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [
    uniqueIndex('recorder_tokens_install_hash').on(t.installId, t.tokenHash),
    index('recorder_tokens_user').on(t.userId, t.installId),
  ],
);

/**
 * One per challenge: Approve on /connect writes it `approved` for 10
 * minutes, Cancel writes it `denied`, and the recorder's poll exchanges an
 * approved one for a token (`redeemed`). No row exists before Approve or
 * Cancel, so a caller without a session never writes one.
 */
export const recorderGrants = sqliteTable(
  'recorder_grants',
  {
    installId: installId(),
    /** base64url SHA-256 of the recorder's code verifier (RFC 7636 S256). */
    challenge: text('challenge').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    deviceName: text('device_name').notNull(),
    status: text('status', { enum: RECORDER_GRANT_STATUSES }).notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at').notNull(),
    /** The last poll that was let through: one per second per grant. */
    lastPollAt: timestamp('last_poll_at'),
    /** The token a redeemed grant became. */
    tokenId: text('token_id'),
  },
  (t) => [
    primaryKey({ columns: [t.installId, t.challenge] }),
    index('recorder_grants_user').on(t.userId, t.status),
    inValues('recorder_grants', 'status', RECORDER_GRANT_STATUSES),
  ],
);

export type Settings = typeof settings.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type Recording = typeof recordings.$inferSelect;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
export type Visibility = (typeof VISIBILITIES)[number];
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];
export type SttProvider = (typeof STT_PROVIDERS)[number];
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];
export type User = typeof users.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Keyterm = typeof keyterms.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];
export type Speaker = typeof speakers.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type Recap = typeof recaps.$inferSelect;
export type RecapVersion = typeof recapVersions.$inferSelect;
export type RecapStatus = (typeof RECAP_STATUSES)[number];
export type RecapProvider = (typeof RECAP_PROVIDERS)[number];
export type Decision = typeof decisions.$inferSelect;
export type RecorderToken = typeof recorderTokens.$inferSelect;
export type RecorderGrant = typeof recorderGrants.$inferSelect;
export type RecorderGrantStatus = (typeof RECORDER_GRANT_STATUSES)[number];
