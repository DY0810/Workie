-- Hand-written: drizzle-kit splits an index expression on its commas. Keep it in step with `effectiveAt` in lib/query.ts.
DROP INDEX `postings_board_idx`;--> statement-breakpoint
CREATE INDEX `postings_board_idx` ON `postings` (`track`,`delisted_at`,max(`posted_at`, coalesce(unixepoch(`first_seen_run`) * 1000, 0)),`posted_at`,`first_seen_run`,`seniority`,`company_norm`,`country`,`city_norm`,`state`,`work_mode`,`is_remote`,`employment_type`,`internship_season`,`paid`,`badges`,`canonical_url`);
