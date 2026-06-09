-- void:allow-destructive
-- Synthetic-monitoring tables (`monitors`, `monitorExecutions`) + two additive
-- `runs` columns (`origin`, `monitorId`). Void's isDestructive() false-positives
-- on the `ON DELETE cascade` FK clauses below (same as the initial migration);
-- creating tables + adding columns is not destructive. Safe — the dashboard has
-- never deployed and there are zero users, so no applied migration is mutated.
CREATE TABLE `monitorExecutions` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`monitorId` text NOT NULL,
	`scheduledFor` integer NOT NULL,
	`startedAt` integer,
	`completedAt` integer,
	`state` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`runId` text,
	`durationMs` integer,
	`errorMessage` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitorId`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitorExecutions_monitor_created_at_idx` ON `monitorExecutions` (`monitorId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `monitorExecutions_project_created_at_idx` ON `monitorExecutions` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`projectId` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`source` text,
	`config` text,
	`intervalSeconds` integer NOT NULL,
	`schedulingStrategy` text DEFAULT 'round_robin' NOT NULL,
	`retryConfig` text,
	`nextRunAt` integer,
	`lastEnqueuedAt` integer,
	`lastRunAt` integer,
	`lastStatus` text,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_project_name_idx` ON `monitors` (`projectId`,`name`);--> statement-breakpoint
CREATE INDEX `monitors_project_created_at_idx` ON `monitors` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `monitors_enabled_next_run_at_idx` ON `monitors` (`enabled`,`nextRunAt`);--> statement-breakpoint
ALTER TABLE `runs` ADD `origin` text DEFAULT 'ci' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `monitorId` text;--> statement-breakpoint
CREATE INDEX `runs_project_monitor_created_at_idx` ON `runs` (`projectId`,`monitorId`,`createdAt`);