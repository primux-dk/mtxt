-- Packet 17: the MCP server's OAuth. oauth_grants holds the authorization
-- codes, oauth_spent_refresh the refresh tokens a connection has spent; an MCP
-- connection is a recorder_tokens row with kind 'mcp' (the app checks kind, as
-- in 0010), so its columns are added there. Additive only. Numbered 0012 on
-- top of packet 15's 0011.
CREATE TABLE `oauth_grants` (
	`install_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`token_id` text,
	PRIMARY KEY(`install_id`, `code_hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_user` ON `oauth_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_expires` ON `oauth_grants` (`install_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_spent_refresh` (
	`install_id` text NOT NULL,
	`refresh_hash` text NOT NULL,
	`token_id` text NOT NULL,
	`spent_at` integer NOT NULL,
	PRIMARY KEY(`install_id`, `refresh_hash`)
);
--> statement-breakpoint
CREATE INDEX `oauth_spent_refresh_token` ON `oauth_spent_refresh` (`install_id`,`token_id`);--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `refresh_hash` text;--> statement-breakpoint
ALTER TABLE `recorder_tokens` ADD `access_expires_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `recorder_tokens_install_refresh` ON `recorder_tokens` (`install_id`,`refresh_hash`);