-- Packet 18: a recording sent to Workers AI Whisper in pieces keeps its
-- progress on the transcript row (pieces planned, pieces done). Additive:
-- null for every transcript sent whole.
ALTER TABLE `transcripts` ADD `chunks_total` integer;--> statement-breakpoint
ALTER TABLE `transcripts` ADD `chunks_done` integer;