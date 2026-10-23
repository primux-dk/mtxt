-- Packet 16: personal API tokens share recorder_tokens with the recorders'
-- tokens (kind, scope and the rate limit's window are added; the app checks
-- kind and scope, since a CHECK would rebuild the table). The audit enum
-- gains api_token_created and api_token_revoked. SQLite cannot alter a
-- CHECK, so audit_events is rebuilt, as in 0007 and 0009: no table
-- references audit_events, so the drop deletes nothing else even though D1
-- ignores the PRAGMA.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`user_id` text NOT NULL,
	`meeting_id` text,
	`meeting_title` text,
	`action` text NOT NULL,
	`details` text,
	`at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_action_check" CHECK("action" IN ('opened', 'exported', 'shared', 'visibility_changed', 'deleted', 'mcp_read', 'mcp_write', 'recorder_connected', 'recorder_disconnected', 'webhook_sent', 'api_token_created', 'api_token_revoked'))
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("id", "install_id", "user_id", "meeting_id", "meeting_title", "action", "details", "at") SELECT "id", "install_id", "user_id", "meeting_id", "meeting_title", "action", "details", "at" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_events_user` ON `audit_events` (`user_id`);--> statement-breakpoint
CREATE INDEX `audit_events_meeting` ON `audit_events` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `audit_events_install_at` ON `audit_events` (`install_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_install_meeting_user_at` ON `audit_events` (`install_id`,`meeting_id`,`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_install_action_at` ON `audit_events` (`install_id`,`action`,`at`);--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `kind` text DEFAULT 'recorder' NOT NULL;--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `rate_window_at` integer;--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `rate_count` integer DEFAULT 0 NOT NULL;