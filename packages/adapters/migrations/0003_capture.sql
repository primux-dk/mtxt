ALTER TABLE `meetings` ADD `title_folded` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `content_type` text DEFAULT 'audio/webm' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `failure` text;--> statement-breakpoint
ALTER TABLE `recordings` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `confirmed_at` integer;--> statement-breakpoint
-- Backfills, written by hand. Rows from packet 1 get their media type from the
-- file extension, their creation time from the meeting's start, and, when they
-- are past uploading, a confirmation at that same time (no new upload event).
-- title_folded is left null: SQLite folds ASCII only, so the app fills it with
-- backfillTitleKeys() at start-up.
UPDATE `recordings` SET `content_type` = CASE lower(substr(`storage_path`, length(rtrim(`storage_path`, replace(`storage_path`, '.', ''))) + 1))
	WHEN 'webm' THEN 'audio/webm'
	WHEN 'mp4' THEN 'audio/mp4'
	WHEN 'm4a' THEN 'audio/mp4'
	WHEN 'mp3' THEN 'audio/mpeg'
	WHEN 'wav' THEN 'audio/wav'
	WHEN 'ogg' THEN 'audio/ogg'
	WHEN 'oga' THEN 'audio/ogg'
	WHEN 'opus' THEN 'audio/ogg'
	WHEN 'flac' THEN 'audio/flac'
	WHEN 'aac' THEN 'audio/aac'
	ELSE 'audio/webm' END;--> statement-breakpoint
UPDATE `recordings` SET `created_at` = coalesce((SELECT `started_at` FROM `meetings` WHERE `meetings`.`id` = `recordings`.`meeting_id`), 0) WHERE `created_at` = 0;--> statement-breakpoint
UPDATE `recordings` SET `confirmed_at` = `created_at` WHERE `confirmed_at` IS NULL AND `status` IN ('confirmed', 'transcribing', 'transcribed', 'failed');
