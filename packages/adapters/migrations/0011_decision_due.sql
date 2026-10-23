-- Packet 15: a decision's due date (a calendar day, YYYY-MM-DD, no zone)
-- and the install's time zone, the day a meeting falls on when the recap
-- draft works out "på torsdag" or "tomorrow". Both only add; the app checks
-- the time zone, since a CHECK would rebuild the settings table.
ALTER TABLE `decisions` ADD `due_on` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `time_zone` text DEFAULT 'UTC' NOT NULL;