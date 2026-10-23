CREATE TABLE `recap_jobs_seen` (
	`transcript_id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`transcript_id`) REFERENCES `transcripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `transcripts_provider_job`;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `claim_token` text;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `raw_path` text;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `recap_enqueued_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_install_provider_job` ON `transcripts` (`install_id`,`provider`,`provider_job_id`);