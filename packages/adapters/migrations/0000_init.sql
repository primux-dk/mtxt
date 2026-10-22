CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`user_id` text NOT NULL,
	`meeting_id` text,
	`action` text NOT NULL,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_action_check" CHECK("action" IN ('opened', 'exported', 'shared', 'visibility_changed', 'deleted', 'mcp_read', 'mcp_write'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_user` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_events_meeting` ON `audit_events` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `audit_events_install_at` ON `audit_events` (`install_id`,`at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`recap_id` text NOT NULL,
	`text` text NOT NULL,
	`owner_user_id` text,
	`done` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `recaps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `decisions_recap` ON `decisions` (`recap_id`);--> statement-breakpoint
CREATE INDEX `decisions_owner` ON `decisions` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `keyterms` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`term` text NOT NULL,
	`boost` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keyterms_install_term` ON `keyterms` (`install_id`,`term`);--> statement-breakpoint
CREATE TABLE `meeting_shares` (
	`install_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`meeting_id`, `user_id`),
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meeting_shares_user` ON `meeting_shares` (`user_id`);--> statement-breakpoint
CREATE INDEX `meeting_shares_install_user` ON `meeting_shares` (`install_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`started_at` integer NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`keep` integer DEFAULT false NOT NULL,
	`template_id` text,
	`archived_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meetings_visibility_check" CHECK("visibility" IN ('private', 'shared', 'company'))
);
--> statement-breakpoint
CREATE INDEX `meetings_owner` ON `meetings` (`owner_id`);--> statement-breakpoint
CREATE INDEX `meetings_template` ON `meetings` (`template_id`);--> statement-breakpoint
CREATE INDEX `meetings_install_owner` ON `meetings` (`install_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `meetings_install_visibility` ON `meetings` (`install_id`,`visibility`);--> statement-breakpoint
CREATE INDEX `meetings_install_started` ON `meetings` (`install_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `recap_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`recap_id` text NOT NULL,
	`author_id` text,
	`body_md` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`recap_id`) REFERENCES `recaps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recap_versions_recap_created` ON `recap_versions` (`recap_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `recap_versions_author` ON `recap_versions` (`author_id`);--> statement-breakpoint
CREATE TABLE `recaps` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`template_id` text,
	`body_md` text DEFAULT '' NOT NULL,
	`current_version_id` text,
	`docx_path` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `recap_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recaps_meeting` ON `recaps` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `recaps_template` ON `recaps` (`template_id`);--> statement-breakpoint
CREATE INDEX `recaps_current_version` ON `recaps` (`current_version_id`);--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`source` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`duration_s` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`delete_audio_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recordings_source_check" CHECK("source" IN ('desktop', 'browser', 'upload', 'teams', 'meet', 'device')),
	CONSTRAINT "recordings_status_check" CHECK("status" IN ('uploading', 'confirmed', 'transcribing', 'transcribed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `recordings_meeting` ON `recordings` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `recordings_uploaded_by` ON `recordings` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `recordings_install_delete_audio` ON `recordings` (`install_id`,`delete_audio_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_one_primary` ON `recordings` (`meeting_id`) WHERE "is_primary" = 1;--> statement-breakpoint
CREATE TABLE `segments` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`transcript_id` text NOT NULL,
	`speaker_id` text,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`speaker_id`) REFERENCES `speakers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `segments_transcript_start` ON `segments` (`transcript_id`,`start_ms`);--> statement-breakpoint
CREATE INDEX `segments_speaker` ON `segments` (`speaker_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`install_id` text PRIMARY KEY NOT NULL,
	`product_name` text NOT NULL,
	`company_name` text,
	`theme_accent` text DEFAULT '#566b45' NOT NULL,
	`theme_primary` text DEFAULT '#111111' NOT NULL,
	`identity_provider` text,
	`stt_provider` text,
	`language` text DEFAULT 'auto' NOT NULL,
	`interface_language` text DEFAULT 'en' NOT NULL,
	`live_transcript_default` integer DEFAULT false NOT NULL,
	`default_visibility` text DEFAULT 'private' NOT NULL,
	`retention_audio_days` integer DEFAULT 30 NOT NULL,
	`retention_transcript_days` integer DEFAULT 365 NOT NULL,
	`mcp_enabled` integer DEFAULT false NOT NULL,
	`recording_sources` text DEFAULT '["desktop","upload","browser"]' NOT NULL,
	CONSTRAINT "settings_identity_provider_check" CHECK("identity_provider" IN ('entra', 'google')),
	CONSTRAINT "settings_stt_provider_check" CHECK("stt_provider" IN ('assemblyai', 'azure', 'elevenlabs', 'workers-ai-whisper', 'local-whisper', 'local-parakeet')),
	CONSTRAINT "settings_default_visibility_check" CHECK("default_visibility" IN ('private', 'shared', 'company')),
	CONSTRAINT "settings_interface_language_check" CHECK("interface_language" IN ('en', 'da'))
);
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`label` text NOT NULL,
	`user_id` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `speakers_meeting` ON `speakers` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `speakers_user` ON `speakers` (`user_id`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`name` text NOT NULL,
	`body_md` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `templates_install` ON `templates` (`install_id`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`recording_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`language` text NOT NULL,
	`raw_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_recording` ON `transcripts` (`recording_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`oidc_subject` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_install_subject` ON `users` (`install_id`,`oidc_subject`);