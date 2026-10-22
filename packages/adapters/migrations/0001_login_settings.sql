ALTER TABLE `settings` ADD `oidc_tenant_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `oidc_client_id` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `oidc_client_secret` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `stt_api_key` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `stt_region` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `admin_emails` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `templates_install_name` ON `templates` (`install_id`,`name`);