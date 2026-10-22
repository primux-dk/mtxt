ALTER TABLE `audit_events` ADD `meeting_title` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `details` text;--> statement-breakpoint
CREATE INDEX `audit_events_install_meeting_user_at` ON `audit_events` (`install_id`,`meeting_id`,`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_install_action_at` ON `audit_events` (`install_id`,`action`,`at`);--> statement-breakpoint
-- Written by hand from here: drizzle-kit has no virtual tables. The search
-- index (src/db/search.ts) holds one row per meeting title, transcript
-- segment and recap, kept in sync by the code that writes them. Every column
-- but `meeting_key` and `text` is UNINDEXED. `meeting_key` is 'm' and the
-- hex of the meeting id, one token, so a meeting's rows are found through
-- the index instead of a scan. unicode61 folds case for every script;
-- diacritics are kept, since å is a letter in Danish, not a decorated a.
CREATE VIRTUAL TABLE `meeting_search` USING fts5(
	`install_id` UNINDEXED,
	`meeting_id` UNINDEXED,
	`meeting_key`,
	`kind` UNINDEXED,
	`ref` UNINDEXED,
	`text`,
	tokenize = 'unicode61 remove_diacritics 0'
);--> statement-breakpoint
INSERT INTO `meeting_search` (`install_id`, `meeting_id`, `meeting_key`, `kind`, `ref`, `text`)
	SELECT `install_id`, `id`, 'm' || lower(hex(`id`)), 'title', `id`, `title` FROM `meetings`;--> statement-breakpoint
INSERT INTO `meeting_search` (`install_id`, `meeting_id`, `meeting_key`, `kind`, `ref`, `text`)
	SELECT s.`install_id`, r.`meeting_id`, 'm' || lower(hex(r.`meeting_id`)), 'segment', s.`id`, s.`text`
	FROM `segments` s
	JOIN `transcripts` t ON t.`id` = s.`transcript_id` AND t.`install_id` = s.`install_id` AND t.`is_comparison` = 0
	JOIN `recordings` r ON r.`id` = t.`recording_id` AND r.`install_id` = s.`install_id`;--> statement-breakpoint
INSERT INTO `meeting_search` (`install_id`, `meeting_id`, `meeting_key`, `kind`, `ref`, `text`)
	SELECT `install_id`, `meeting_id`, 'm' || lower(hex(`meeting_id`)), 'recap', `id`, `body_md` FROM `recaps` WHERE `body_md` != '';--> statement-breakpoint
-- Audit rows from before 0004 get the title of the meeting they point at.
UPDATE `audit_events` SET `meeting_title` = (
	SELECT m.`title` FROM `meetings` m WHERE m.`id` = `audit_events`.`meeting_id` AND m.`install_id` = `audit_events`.`install_id`
) WHERE `meeting_title` IS NULL AND `meeting_id` IS NOT NULL;
