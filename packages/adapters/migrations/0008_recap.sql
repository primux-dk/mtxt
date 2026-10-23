ALTER TABLE `decisions` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_versions` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `recap_versions` ADD `note` text;--> statement-breakpoint
-- Number the versions a recap already has, oldest first, before the index holds them unique.
UPDATE `recap_versions` SET `number` = (
  SELECT count(*) FROM `recap_versions` v
  WHERE v.`recap_id` = `recap_versions`.`recap_id`
    AND (v.`created_at` < `recap_versions`.`created_at`
      OR (v.`created_at` = `recap_versions`.`created_at` AND v.`id` <= `recap_versions`.`id`))
);--> statement-breakpoint
-- Decisions keep the order they were written in.
UPDATE `decisions` SET `position` = (
  SELECT count(*) FROM `decisions` d
  WHERE d.`recap_id` = `decisions`.`recap_id` AND d.`rowid` < `decisions`.`rowid`
);--> statement-breakpoint
CREATE UNIQUE INDEX `recap_versions_recap_number` ON `recap_versions` (`recap_id`,`number`);--> statement-breakpoint
ALTER TABLE `recaps` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `recaps` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `recaps` ADD `draft_token` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `recap_provider` text DEFAULT 'workers-ai' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `recap_model` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `recap_api_key` text;