PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`source` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`duration_s` integer NOT NULL,
	`sha256` text,
	`size_bytes` integer,
	`content_type` text NOT NULL,
	`storage_path` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`failure` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`confirmed_at` integer,
	`delete_audio_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recordings_source_check" CHECK("source" IN ('desktop', 'browser', 'upload', 'teams', 'meet', 'device')),
	CONSTRAINT "recordings_status_check" CHECK("status" IN ('uploading', 'confirmed', 'transcribing', 'transcribed', 'failed'))
);
--> statement-breakpoint
-- Edited by hand: drizzle-kit selected the new columns from the old table. Rows
-- from before this migration get the generic content type; v0.1 had none.
INSERT INTO `__new_recordings`("id", "install_id", "meeting_id", "uploaded_by", "source", "is_primary", "duration_s", "sha256", "size_bytes", "content_type", "storage_path", "status", "delete_audio_at") SELECT "id", "install_id", "meeting_id", "uploaded_by", "source", "is_primary", "duration_s", "sha256", "size_bytes", 'application/octet-stream', "storage_path", "status", "delete_audio_at" FROM `recordings`;--> statement-breakpoint
DROP TABLE `recordings`;--> statement-breakpoint
ALTER TABLE `__new_recordings` RENAME TO `recordings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `recordings_meeting` ON `recordings` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `recordings_uploaded_by` ON `recordings` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `recordings_install_delete_audio` ON `recordings` (`install_id`,`delete_audio_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_one_primary` ON `recordings` (`meeting_id`) WHERE "is_primary" = 1;--> statement-breakpoint
ALTER TABLE `meetings` ADD `title_folded` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Best effort for rows from before this migration: SQLite folds ASCII only. The app writes the full fold.
UPDATE `meetings` SET `title_folded` = lower(`title`);
