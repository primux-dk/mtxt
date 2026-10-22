DROP INDEX `transcripts_recording`;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `status` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `provider_job_id` text;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `is_comparison` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_provider_job` ON `transcripts` (`provider`,`provider_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_recording` ON `transcripts` (`recording_id`) WHERE "is_comparison" = 0;--> statement-breakpoint
ALTER TABLE `recordings` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `webhook_secret` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `ai_gateway_id` text;--> statement-breakpoint
ALTER TABLE `speakers` ADD `speaker_index` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_meeting_index` ON `speakers` (`meeting_id`,`speaker_index`) WHERE "speaker_index" is not null;