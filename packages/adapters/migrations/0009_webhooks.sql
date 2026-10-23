CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`event` text NOT NULL,
	`meeting_id` text,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_status_code` integer,
	`last_error` text,
	`last_attempt_at` integer,
	`dedupe_key` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_id` ON `webhook_deliveries` (`endpoint_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint` ON `webhook_deliveries` (`install_id`,`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status` ON `webhook_deliveries` (`install_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_meeting` ON `webhook_deliveries` (`install_id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_dedupe` ON `webhook_deliveries` (`install_id`,`endpoint_id`,`dedupe_key`) WHERE "dedupe_key" is not null;--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`install_id` text NOT NULL,
	`label` text,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_install` ON `webhook_endpoints` (`install_id`,`created_at`);--> statement-breakpoint
-- The audit enum gains webhook_sent. SQLite cannot alter a CHECK, so
-- audit_events is rebuilt, as in 0007: no table references audit_events, so
-- the drop deletes nothing else even though D1 ignores the PRAGMA.
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
	CONSTRAINT "audit_events_action_check" CHECK("action" IN ('opened', 'exported', 'shared', 'visibility_changed', 'deleted', 'mcp_read', 'mcp_write', 'recorder_connected', 'recorder_disconnected', 'webhook_sent'))
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
ALTER TABLE `meetings` ADD `webhook_consent_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `webhook_auto_send` text DEFAULT 'off' NOT NULL;