DROP INDEX `templates_install_name`;--> statement-breakpoint
ALTER TABLE `templates` ADD `name_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill by hand. SQLite's lower() folds ASCII only; the app's refoldTemplateKeys() brings
-- every key to the full fold on the first request. Two rows of one install whose names lower to
-- the same key would block the unique index, so the later row (by rowid) gets its id appended.
-- The collision test reads the names, not name_key, so it does not see its own updates.
UPDATE `templates` SET `name_key` = lower(trim(`name`));--> statement-breakpoint
UPDATE `templates` SET `name_key` = `name_key` || '-' || `id` WHERE EXISTS (SELECT 1 FROM `templates` AS `earlier` WHERE `earlier`.`install_id` = `templates`.`install_id` AND lower(trim(`earlier`.`name`)) = lower(trim(`templates`.`name`)) AND `earlier`.`rowid` < `templates`.`rowid`);--> statement-breakpoint
CREATE UNIQUE INDEX `templates_install_name_key` ON `templates` (`install_id`,`name_key`);--> statement-breakpoint
ALTER TABLE `settings` ADD `admin_bootstrap_claimed_at` integer;--> statement-breakpoint
-- Backfill by hand: an install with any user or any admin address has had its first claim.
UPDATE `settings` SET `admin_bootstrap_claimed_at` = cast(unixepoch('subsec') * 1000 as integer) WHERE `admin_emails` <> '[]' OR EXISTS (SELECT 1 FROM `users` WHERE `users`.`install_id` = `settings`.`install_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_install_email` ON `users` (`install_id`,`email`);