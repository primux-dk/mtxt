CREATE TABLE `recorder_grants` (
	`install_id` text NOT NULL,
	`challenge` text NOT NULL,
	`user_id` text NOT NULL,
	`device_name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_poll_at` integer,
	`token_id` text,
	PRIMARY KEY(`install_id`, `challenge`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recorder_grants_status_check" CHECK("status" IN ('approved', 'denied', 'redeemed'))
);
--> statement-breakpoint
CREATE INDEX `recorder_grants_user` ON `recorder_grants` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `recorder_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`user_id` text NOT NULL,
	`device_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recorder_tokens_install_hash` ON `recorder_tokens` (`install_id`,`token_hash`);--> statement-breakpoint
CREATE INDEX `recorder_tokens_user` ON `recorder_tokens` (`user_id`,`install_id`);--> statement-breakpoint
-- The audit enum gains recorder_connected and recorder_disconnected. SQLite
-- cannot alter a CHECK, so audit_events is rebuilt. D1 ignores the PRAGMA
-- inside its migration transaction (packet 3's cascade), which is safe here:
-- no table references audit_events, so dropping it deletes nothing else.
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
	CONSTRAINT "audit_events_action_check" CHECK("action" IN ('opened', 'exported', 'shared', 'visibility_changed', 'deleted', 'mcp_read', 'mcp_write', 'recorder_connected', 'recorder_disconnected'))
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
CREATE INDEX `audit_events_install_action_at` ON `audit_events` (`install_id`,`action`,`at`);