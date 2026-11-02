CREATE INDEX `private_application_worker_state` ON `private_application` (`owner_id`,`worker_id`,`state`,`available_at`);--> statement-breakpoint
CREATE INDEX `private_application_started` ON `private_application` (`owner_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `private_application_by_state` ON `private_application` (`state`);