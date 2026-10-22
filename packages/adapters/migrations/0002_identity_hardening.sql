DROP INDEX `templates_install_name`;--> statement-breakpoint
ALTER TABLE `templates` ADD `name_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill by hand: SQLite's lower() folds ASCII only, which the app's key refines on the next rename.
UPDATE `templates` SET `name_key` = lower(trim(`name`));--> statement-breakpoint
CREATE UNIQUE INDEX `templates_install_name_key` ON `templates` (`install_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `settings` ADD `admin_bootstrap_claimed_at` integer;--> statement-breakpoint
-- Backfill by hand: an install that already has admins has had its first claim.
UPDATE `settings` SET `admin_bootstrap_claimed_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `admin_emails` <> '[]';--> statement-breakpoint
CREATE UNIQUE INDEX `users_install_email` ON `users` (`install_id`,`email`);