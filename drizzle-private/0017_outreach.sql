CREATE TABLE `private_outreach` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`company_key` text NOT NULL,
	`company` text NOT NULL,
	`roles` text NOT NULL,
	`recruiter` text,
	`overlap` text,
	`subject` text,
	`body` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	`thread_url` text,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "private_outreach_json" CHECK(json_valid("private_outreach"."roles") and length(cast("private_outreach"."roles" as blob)) <= 16384),
	CONSTRAINT "private_outreach_state" CHECK("private_outreach"."state" in ('draft','approved','sending','sent','skipped','failed') and ("private_outreach"."state" not in ('approved','sending','sent') or ("private_outreach"."recruiter" is not null and "private_outreach"."body" is not null)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_outreach_owner_company` ON `private_outreach` (`owner_id`,`company_key`);--> statement-breakpoint
CREATE INDEX `private_outreach_owner_state` ON `private_outreach` (`owner_id`,`state`);--> statement-breakpoint
CREATE TABLE `private_outreach_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`template` text NOT NULL,
	`enabled_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `private_user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "private_outreach_settings_template" CHECK(length("private_outreach_settings"."template") between 1 and 8000)
);
